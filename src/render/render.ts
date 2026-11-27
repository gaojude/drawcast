/** The two things a script can be turned into: a video, and a still picture of one moment. */
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { check, type Report } from "../format/check.ts";
import { expand, type ResolvedGeometry } from "../format/expand.ts";
import { axesImageKey, axesSvg } from "../shared/axes.ts";
import type { PrepareRequest } from "../player/main.ts";
import { segmentFrames } from "../shared/h264.ts";
import { prepareOutputFiles, publishFile } from "../shared/files.ts";
import { DEFAULT_CANVAS, type Formula, OUTPUT_SCALE, type Script, type StepAudio } from "../shared/types.ts";
import { type Listener, SAMPLE_RATE, cachedNarration, estimateNarration, narrate } from "../voice/narrate.ts";
import { resolveVoice } from "../voice/voice.ts";
import { type Audio, pcm16 } from "../voice/wav.ts";
import { type Output, requireFfmpeg, startEncoder, startMuxer } from "./encode.ts";
import { type Player, openPlayer } from "./player.ts";
import { appendStepIndex, stepFrameIndex, type StepIndex } from "./step-index.ts";
import { parseSteps, SHEET_COLUMNS, SHEET_STEPS, SHEET_TILE, sheetPage } from "../shared/steps.ts";
export { parseSteps } from "../shared/steps.ts";

type Log = (line: string) => void;

/** Accumulate wall time across successive attempts, including time waiting for input. */
function stopwatch() {
  let elapsed = 0;
  return {
    get ms() { return elapsed; },
    start() {
      const started = performance.now();
      return () => { elapsed += performance.now() - started; };
    },
  };
}

type RecordingOutput = Output & { encodingTimer?: ReturnType<typeof stopwatch> };

/** A script the checker turned down. */
export class ScriptError extends Error {
  report: Report;

  constructor(report: Report) {
    super(`The script has ${report.errors.length} error(s).`);
    this.report = report;
  }
}

export interface Loaded {
  script: Script;
  sourceFile: string;
  baseDir: string;
  report: Report;
}

export async function loadScript(file: string, signal?: AbortSignal): Promise<Loaded> {
  const baseDir = path.dirname(path.resolve(file));
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(file, { encoding: "utf8", signal })).replace(/^\uFEFF/, ""));
  } catch (e) {
    signal?.throwIfAborted();
    const { message } = e as Error;
    // LaTeX is full of backslashes, and JSON takes one as the start of an escape
    const hint = /escape/i.test(message) ? `. In JSON a backslash is written twice: "\\\\alpha", not "\\alpha".` : "";
    throw new Error(`Could not read ${file}: ${message}${hint}`);
  }
  const geometry: ResolvedGeometry = new WeakMap();
  const report = await check(parsed, baseDir, geometry);
  signal?.throwIfAborted();
  if (report.errors.length) throw new ScriptError(report);
  return { script: expand(parsed as Script, geometry), sourceFile: path.resolve(file), baseDir, report };
}

/** Every formula the script draws, typeset and keyed by its LaTeX. */
export async function typesetFormulas(script: Script): Promise<Record<string, Formula>> {
  const actions = script.steps.flatMap((s) => s.do ?? []);
  const specs = [...actions.flatMap((a) => a.add ?? []), ...actions.flatMap((a) => a.update ?? [])];
  const sources = specs.map((spec) => spec.tex).filter((tex): tex is string => !!tex);
  if (!sources.length) return {};
  const { typeset } = await import("../math/typeset.ts");
  return Object.fromEntries(sources.map((tex) => [tex, typeset(tex)]));
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** DRAWCAST_ENCODER=ffmpeg turns the browser's encoder down, to compare the two ways or to get past one that misbehaves. */
const browserMayEncode = () => process.env.DRAWCAST_ENCODER !== "ffmpeg";

function imageSources(script: Script): Set<string> {
  return new Set(script.steps.flatMap((s) => s.do ?? []).flatMap((a) => a.add ? [a.add].flat() : []).map((el) => el.src).filter((s): s is string => !!s));
}

async function prepareOutputs(loaded: Loaded, outputs: string[]) {
  const inputs = [loaded.sourceFile, ...Array.from(imageSources(loaded.script), (src) => path.resolve(loaded.baseDir, src))];
  await prepareOutputFiles(inputs, outputs, "input script and its images");
}

/**
 * What the player page needs before any timing is known. For a video, `fps` is given: the size is then
 * rounded up to what H.264 can hold, and the page is asked to look for its encoder.
 */
export async function playerRequest(loaded: Loaded, width: number | undefined, captions: boolean, fps?: number, signal?: AbortSignal): Promise<PrepareRequest> {
  signal?.throwIfAborted();
  const { baseDir } = loaded;
  const script = { ...loaded.script, captions };
  const canvas = { ...DEFAULT_CANVAS, ...script.canvas };
  if (width !== undefined && (!Number.isSafeInteger(width) || width < 1)) throw new Error("--width must be a positive whole number of pixels.");
  const outWidth = Math.round(width ?? canvas.width * OUTPUT_SCALE);
  const outHeight = Math.max(1, Math.round((outWidth * canvas.height) / canvas.width));
  if (!Number.isSafeInteger(outWidth) || !Number.isSafeInteger(outHeight) || outWidth < 1) throw new Error("The canvas and output width must give a usable image size.");
  const images: Record<string, string> = {};
  for (const step of script.steps) for (const action of step.do ?? []) {
    for (const el of [action.add ?? []].flat()) {
      if (el.type === "axes") images[axesImageKey(el.id)] = `data:image/svg+xml;base64,${Buffer.from(axesSvg(el)).toString("base64")}`;
    }
  }
  for (const src of imageSources(script)) {
    const data = await readFile(path.resolve(baseDir, src), { signal });
    images[src] = `data:${IMAGE_MIME[path.extname(src).toLowerCase()]};base64,${data.toString("base64")}`;
  }
  const math = await typesetFormulas(script);
  signal?.throwIfAborted();
  if (fps === undefined) return { script, images, math, output: { width: outWidth, height: outHeight } };
  return {
    script,
    images,
    math,
    // an odd size gains a row or column of the canvas, not a black edge
    output: { width: outWidth + (outWidth % 2), height: outHeight + (outHeight % 2) },
    // two encoders keep one page busy; more wait on each other
    video: browserMayEncode() ? { fps, lanes: os.availableParallelism() >= 4 ? 2 : 1 } : undefined,
  };
}

/** A step's audio as the player is told about it: without its captions when they are turned off. */
const timing = (step: StepAudio | null, captions: boolean) => step && (captions ? step : { ...step, captions: [] });

/** Logs how far along the frames are, in tenths. */
function progress(frames: number, log: Log): (done: number) => void {
  let shown = 0;
  return (done) => {
    const percent = Math.floor((done / frames) * 10) * 10;
    if (percent > shown) log(`  ${(shown = percent)}%`);
  };
}

/** Something that happens now and then, for others to wait on. */
function signal(): { wait(): Promise<void>; fire(): void } {
  let waiting: (() => void)[] = [];
  return {
    wait: () => new Promise((resolve) => waiting.push(resolve)),
    fire() {
      const woken = waiting;
      waiting = [];
      for (const wake of woken) wake();
    },
  };
}

/**
 * A video in the telling. Its narration is spoken a step at a time, and each step that arrives settles a
 * little more of the video from its start: when the step after it begins, what is drawn until then, and
 * what is heard. So the start of the video can be drawn and encoded while the rest is still being spoken,
 * which takes longer than anything else a render does.
 */
export interface Telling {
  /** how many frames are settled: nothing still to be spoken will change them */
  readonly frames: number;
  /** how much of the sound is settled, in samples */
  readonly samples: number;
  /** the length of the video in seconds; null until the last step has been spoken */
  readonly duration: number | null;
  /** the step (1-based) whose finished canvas is the cover; null until that step has been spoken, and when there is no cover */
  readonly cover: number | null;
  /**
   * Which telling this is. A voice that cannot go on hands the whole script to another, and the video
   * is then told again from the start: this goes up, nothing is settled any more, and whatever was made
   * of the video so far is of one that will not be.
   */
  readonly round: number;
  /** Resolves the next time more is settled, or the telling starts over. Rejects if the narration has failed. */
  more(): Promise<void>;
  /** What stopped the telling, if anything did: the narration failing, or the page. */
  readonly failure: unknown;
  /** The sound from sample `from` up to sample `to`, which has to be settled. */
  sound(from: number, to: number): Float32Array;
  /** Resolves when all of it is settled, with the length of the video. */
  whole: Promise<{ duration: number; frames: number; index: StepIndex }>;
  narration: Promise<unknown>;
}

/**
 * Starts the narration (`narrate` is given who to report each step to), tells the page of the steps as
 * they arrive, and keeps account of what that settles. `cover` is the step (1-based) the cover shows.
 */
export function tell(opening: Promise<Player>, script: Script, narrate: (listener: Listener) => Promise<unknown>, o: { fps: number; captions: boolean; cover?: number | null; log: Log }): Telling {
  let steps: (StepAudio | null)[] = [];
  let clips: (Audio | null)[] = [];
  const spoken = signal();
  const settled = signal();
  let stepStarts: number[] = [];
  let frames = 0;
  let samples = 0;
  let duration: number | null = null;
  let cover: number | null = null;
  let round = 0;
  let failure: unknown = null;

  let narrationFinished = false;
  let narrationError: Error | undefined;
  const narrating = narrate({
    spoken(index, step, clip) {
      steps[index] = step;
      clips[index] = clip;
      spoken.fire();
    },
    startOver() {
      // nothing that was settled in the first voice holds in the second
      round++;
      steps = [];
      clips = [];
      stepStarts = [];
      frames = samples = 0;
      duration = cover = null;
      spoken.fire();
      settled.fire();
    },
  });
  narrating.then(() => {
    narrationFinished = true;
    spoken.fire();
  }, (error) => {
    narrationError = error instanceof Error ? error : new Error(String(error));
    spoken.fire();
  });

  const whole = (async () => {
    const player = await opening;
    // the round the page's timeline is of, and how many of that round's steps the page has been told
    let paged = 0;
    let told = 0;
    while (paged !== round || told < script.steps.length) {
      if (narrationError) throw narrationError;
      if (paged !== round) {
        // the page forgets the first voice's timing too
        paged = round;
        told = 0;
        await player.startOver();
        continue;
      }
      if (steps.length === told) {
        // woken by a step being spoken, by starting over, or by the narration failing
        if (narrationFinished) throw new Error(`Narration ended after ${told} of ${script.steps.length} steps.`);
        await spoken.wait();
        continue;
      }
      const batch = steps.slice(told);
      const schedule = await player.schedule(batch.map((step) => timing(step, o.captions)));
      // started over meanwhile: that was the first voice's timing
      if (paged !== round) continue;
      told += batch.length;
      stepStarts = schedule.stepStarts;
      // a frame is settled when its time is before `settled`; all of them are, once the length is known
      frames = Math.ceil(schedule.settled * o.fps);
      samples = schedule.duration === null ? Math.floor(schedule.settled * SAMPLE_RATE) : Math.ceil(schedule.duration * SAMPLE_RATE);
      if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(samples)) throw new Error("The timeline is too long to represent at this frame rate and sample rate.");
      duration = schedule.duration;
      // the canvas as that step is done, which is settled as soon as the step is scheduled
      cover = o.cover && schedule.stepDone[o.cover - 1] !== undefined ? o.cover : null;
      if (duration !== null) o.log(`Video: ${duration.toFixed(1)} s, ${frames} frames`);
      settled.fire();
      if (duration !== null && told === script.steps.length) return { duration, frames, index: stepFrameIndex(stepStarts, schedule.stepDone, o.fps, frames, cover !== null) };
    }
    throw new Error("The player did not finish scheduling the script.");
  })();
  whole.catch((e) => {
    failure = e instanceof Error ? e : new Error(String(e));
    settled.fire();
  });

  return {
    get frames() {
      return frames;
    },
    get samples() {
      return samples;
    },
    get duration() {
      return duration;
    },
    get cover() {
      return cover;
    },
    get round() {
      return round;
    },
    get failure() {
      return failure;
    },
    more: () => (failure ? Promise.reject(failure) : settled.wait()),
    sound(from, to) {
      const out = new Float32Array(to - from);
      stepStarts.forEach((start, i) => {
        const clip = clips[i];
        if (!clip) return;
        const at = Math.round(start * SAMPLE_RATE);
        const a = Math.max(from, at);
        const b = Math.min(to, at + clip.samples.length);
        if (b > a) out.set(clip.samples.subarray(a - at, b - at), a - from);
      });
      return out;
    },
    whole,
    narration: narrating,
  };
}

/**
 * The quick way to the file: the browser's own encoder makes the H.264 in the page, in segments that
 * several encoders share, and ffmpeg only wraps the result, taking the narration in as it is spoken.
 * A segment is made as soon as all of its frames are settled. `guess` is about how many frames there
 * will be, to choose the length of a segment before the length of the video is known. With `cover`, the
 * first frame is the telling's cover instead of the empty canvas.
 *
 * False when this browser cannot do it, and then the player is still open for the other way. Either way
 * closes the player once the frames are out.
 */
export async function recordInBrowser(player: Player, telling: Telling, o: RecordingOutput & { guess: number; cover: boolean; log: Log }): Promise<boolean> {
  if (!browserMayEncode()) return false;
  // the page has been looking for its encoder since it opened
  const { encoder: info, tried } = await player.encoder().catch((e: Error) => ({ encoder: null, tried: [e.message.split("\n")[0]] }));
  o.signal?.throwIfAborted();
  if (!info) {
    o.log("  This browser has no H.264 encoder to use, so ffmpeg encodes frame by frame, which takes several times longer.");
    for (const line of tried) o.log(`    ${line}`);
    return false;
  }

  // Once round, unless the narration starts over in another voice: then what was made is thrown away,
  // and the video is made again from what that voice says.
  for (;;) {
    const round = telling.round;
    const stopTiming = o.encodingTimer?.start();
    const muxer = startMuxer({ ...o, color: info.color, sampleRate: SAMPLE_RATE });
    // set when the round is over before the video is: it started over, or something broke
    let over = false;
    let stop = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const news = () => Promise.race([telling.more(), stopped]);
    const ended = () => over || telling.round !== round;

    // how long a segment is: a guess while the length of the video is unknown
    let size = segmentFrames(o.guess, o.fps, info.lanes);
    let sized = false;
    // The cover is a segment of its own, the first frame alone. It shows the end of a step that may be
    // spoken late, and the segments after it need not wait for that.
    let covered = !o.cover;
    /** the frames of each segment handed out so far */
    const counts: number[] = o.cover ? [1] : [];
    let next = counts.length; // the first frame that is in no segment yet
    const made = new Map<number, Buffer>();
    let written = 0;
    let done = 0;
    let report: ((done: number) => void) | undefined;

    /** The next segment to make, once every frame of it is settled; null when there are no more to make. */
    const take = async (): Promise<{ index: number; first: number; count: number; cover?: number } | null> => {
      for (;;) {
        if (ended()) return null;
        if (!covered && telling.cover !== null) {
          covered = true;
          return { index: 0, first: 0, count: 1, cover: telling.cover };
        }
        const total = telling.duration === null ? null : telling.frames;
        if (total !== null) {
          if (next >= total) return null;
          // What is left can now be shared out evenly between the lanes. With the speech in the cache
          // that is the whole video, before the first segment is made.
          if (!sized) size = segmentFrames(total - next, o.fps, info.lanes);
          sized = true;
        }
        const count = total === null ? size : Math.min(size, total - next);
        if (next + count <= telling.frames) {
          const segment = { index: counts.length, first: next, count };
          counts.push(count);
          next += count;
          return segment;
        }
        await news();
      }
    };
    // segments go into the file in order, whichever lane finishes first
    let writing = Promise.resolve();
    const write = async () => {
      for (let data; !ended() && (data = made.get(written)); written++) {
        made.delete(written);
        await muxer.write(data);
        done += counts[written];
        // how far along is only known once the length is
        if (telling.duration !== null) (report ??= progress(telling.frames, o.log))(done);
      }
    };
    const work = async (lane: number) => {
      for (let segment; (segment = await take()); ) {
        const data = await player.encodeSegment(lane, segment.first, segment.count, segment.cover);
        if (!data.length) throw new Error("The browser returned an empty video segment.");
        made.set(segment.index, data);
        await (writing = writing.then(write));
      }
    };
    // the sound goes to ffmpeg as it settles, so that it is encoded along the way and not all at the end
    const sound = async () => {
      let sent = 0;
      while (!ended()) {
        if (sent < telling.samples) {
          const end = Math.min(sent + SAMPLE_RATE, telling.samples);
          await muxer.sound(pcm16(telling.sound(sent, end)));
          sent = end;
        } else if (telling.duration !== null) break;
        else await news();
      }
      muxer.endSound();
    };
    // One that breaks stops the others, and all of them are waited for: a lane is in the middle of a
    // segment in the page, and must be out of it before anything else is asked of that lane.
    const ending = async (work: Promise<void>) => {
      try {
        await work;
      } catch (e) {
        over = true;
        stop();
        await muxer.abort();
        throw e;
      }
    };
    const lanes = Array.from({ length: info.lanes }, (_, lane) => ending(work(lane)));
    const picture = Promise.allSettled(lanes).then((results) => {
      muxer.endVideo();
      const error = results.find((result) => result.status === "rejected");
      if (error) throw error.reason;
    });
    const outcome = await Promise.allSettled([picture, ending(sound())]);
    const broken = outcome.find((result) => result.status === "rejected");

    if (!broken && telling.round === round) {
      // the browser has nothing left to do, and closes while ffmpeg finishes the file
      try {
        await muxer.finish().finally(stopTiming);
      } catch (e) {
        o.signal?.throwIfAborted();
        await player.stopEncoding().catch(() => {});
        o.log(`  Could not mux the browser video (${(e as Error).message}). Encoding frame by frame with ffmpeg instead.`);
        return false;
      }
      await player.close();
      return true;
    }
    await muxer.abort();
    stopTiming?.();
    o.signal?.throwIfAborted();
    // a narration that failed is the end of the render, whichever way it is encoded
    if (telling.failure) {
      await player.stopEncoding().catch(() => {});
      throw telling.failure;
    }
    if (telling.round === round) {
      await player.stopEncoding().catch(() => {});
      o.log(`  The quick way to encode failed (${((broken as PromiseRejectedResult).reason as Error).message.split("\n")[0]}). Encoding frame by frame with ffmpeg instead.`);
      return false;
    }
  }
}

/**
 * The way that always works: every frame leaves the browser as a PNG and ffmpeg encodes the lot. With
 * `cover`, the first frame is the canvas at that time instead of the empty one.
 */
export async function recordWithFfmpeg(player: Player, o: RecordingOutput & { audio: string; pcmRate?: number; frames: number; cover: number | null; log: Log }): Promise<void> {
  const stopTiming = o.encodingTimer?.start();
  const encoder = startEncoder(o);
  const report = progress(o.frames, o.log);
  try {
    let last: Buffer | null = null;
    for (let i = 0; i < o.frames; i++) {
      o.signal?.throwIfAborted();
      const cover = i === 0 && o.cover !== null;
      last = (await (cover ? player.stepFrame(o.cover!) : player.frame(i / o.fps))) ?? last;
      if (!last) throw new Error("The player did not produce a first video frame.");
      await encoder.write(last);
      report(i + 1);
    }
  } catch (e) {
    await encoder.abort();
    throw e;
  }
  await Promise.all([encoder.finish().finally(stopTiming), player.close()]);
}

export interface RenderOptions {
  output: string;
  fps: number;
  /** output width in pixels; the height follows from the canvas */
  width?: number;
  voice?: string;
  speed?: number;
  captions?: boolean;
  ttsCommand?: string;
  signal?: AbortSignal;
  log: Log;
}

export async function renderVideo(loaded: Loaded, o: RenderOptions): Promise<{ duration: number; speechMs: number; encodingMs: number }> {
  o.signal?.throwIfAborted();
  const { script } = loaded;
  if (!Number.isFinite(o.fps) || o.fps <= 0) throw new Error("--fps must be a positive frame rate.");
  const speed = speakingRate(o.speed ?? script.speed);
  const speechTimer = stopwatch();
  const encodingTimer = stopwatch();
  const finishVoiceSelection = speechTimer.start();
  const voice = await resolveVoice({
    spec: o.voice ?? script.voice,
    narration: script.steps.map((s) => s.say ?? "").join(" "),
    ttsCommand: o.ttsCommand,
    log: o.log,
  });
  finishVoiceSelection();
  await prepareOutputs(loaded, [o.output]);
  const ffmpeg = requireFfmpeg();
  // The first frame is a cover, the canvas as this step ends: the empty canvas makes a poor thumbnail.
  const cover = script.cover === false ? null : (script.cover ?? 1);
  // The browser starts, and loads the page with its fonts and images, while the narration is spoken.
  const captions = o.captions ?? script.captions ?? true;
  const request = await playerRequest(loaded, o.width, captions, o.fps, o.signal);
  const work = await mkdtemp(path.join(path.dirname(path.resolve(o.output)), ".drawcast-"));
  const controller = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
  const opening = openPlayer(request, o.log, signal);
  o.log("Narration");
  // And the video is drawn behind the narration, as far as it has been spoken.
  const finishSpeech = speechTimer.start();
  const telling = tell(opening, script, (listener) => narrate(script, voice, speed, o.log, listener, signal).finally(finishSpeech), {
    fps: o.fps,
    captions,
    cover,
    log: o.log,
  });

  let video: Awaited<Telling["whole"]>;
  try {
    const player = await opening;
    const job = { output: path.join(work, "video.mp4"), fps: o.fps, ffmpeg, log: o.log, signal, encodingTimer };
    if (!(await recordInBrowser(player, telling, { ...job, guess: guessFrames(script, o.fps), cover: cover !== null }))) {
      // the slow way takes the narration whole, from a file
      const { frames } = await telling.whole;
      const audioFile = path.join(work, "narration.pcm");
      const audio = await open(audioFile, "w");
      try {
        for (let from = 0; from < telling.samples; from += SAMPLE_RATE) {
          signal.throwIfAborted();
          await audio.writeFile(pcm16(telling.sound(from, Math.min(from + SAMPLE_RATE, telling.samples))));
        }
      } finally {
        await audio.close();
      }
      await recordWithFfmpeg(player, { ...job, audio: audioFile, pcmRate: SAMPLE_RATE, frames, cover: telling.cover });
    }
    video = await telling.whole;
    signal.throwIfAborted();
    await appendStepIndex(job.output, video.index, signal);
    await publishFile(job.output, o.output, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    controller.abort();
    try {
      const player = await opening.catch(() => null);
      await Promise.all([player?.close(), telling.narration.catch(() => {})]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return { duration: video.duration, speechMs: speechTimer.ms, encodingMs: encodingTimer.ms };
}

function speakingRate(value: number | undefined): number {
  const speed = value ?? 1;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error("--speed must be between 0.5 and 2.");
  return speed;
}

/** About how many frames a video will have, going by the length of what is said: enough to choose a segment's length by. */
function guessFrames(script: Script, fps: number): number {
  const seconds = estimateNarration(script).steps.reduce((total, step, i) => total + (step?.duration ?? script.steps[i].duration ?? 1) + 0.5, 1.5);
  return Math.ceil(seconds * fps);
}

export interface SnapshotOptions {
  /** the file to write; with several pictures, each gets a suffix before the extension */
  output: string;
  /** seconds into the video, with pointer and captions as the video shows them */
  at?: number;
  /** instead of `at`: the steps (1-based) to show, each as it is done. Left out, the last step. */
  steps?: number[];
  /** the steps on one picture, in a grid, instead of a picture each */
  sheet?: boolean;
  width?: number;
  voice?: string;
  speed?: number;
  captions?: boolean;
  ttsCommand?: string;
  signal?: AbortSignal;
  log: Log;
}

/**
 * Stills of a script. Nothing is spoken: a sentence an earlier render spoke takes as long as it did then,
 * and any other is estimated from its syllables. Returns each file written, with what it shows.
 */
export async function renderSnapshot(loaded: Loaded, o: SnapshotOptions): Promise<{ files: { file: string; shows: string }[]; timing: string }> {
  o.signal?.throwIfAborted();
  const { script } = loaded;
  const canvas = { ...DEFAULT_CANVAS, ...script.canvas };
  const speed = speakingRate(o.speed ?? script.speed);
  if (o.at !== undefined && (o.steps || o.sheet)) throw new Error("Use --at on its own, or select steps with --step and --sheet.");
  if (o.at !== undefined && !Number.isFinite(o.at)) throw new Error("--at must be a finite number of seconds.");
  const steps = o.steps ?? (o.sheet ? parseSteps("all", script.steps.length) : [script.steps.length]);
  if (!steps.length || steps.some((s) => !Number.isInteger(s) || s < 1 || s > script.steps.length)) throw new Error(`--step must be step numbers from 1 to ${script.steps.length}, or "all".`);
  const pageSize = o.sheet ? SHEET_STEPS : 1;
  const pages = Array.from({ length: Math.ceil(steps.length / pageSize) }, (_, i) => steps.slice(i * pageSize, (i + 1) * pageSize));
  const outputs = pages.map((part, i) => {
    if (pages.length === 1) return o.output;
    if (o.sheet) return sheetPage(o.output, i);
    return o.output.replace(/(\.png)?$/i, `-step${part[0]}.png`);
  });
  await prepareOutputs(loaded, outputs);
  const captions = o.captions ?? script.captions ?? true;
  const voice = await resolveVoice({ spec: o.voice ?? script.voice, narration: script.steps.map((s) => s.say ?? "").join(" "), ttsCommand: o.ttsCommand, log: o.log });
  // a still is looked at, not watched: the canvas's own size is plenty, and quicker to make and to read
  const request = await playerRequest(loaded, o.width ?? Math.round(canvas.width), captions, undefined, o.signal);
  const work = await mkdtemp(path.join(path.dirname(path.resolve(o.output)), ".drawcast-"));
  let player: Player | undefined;
  try {
    player = await openPlayer(request, o.log, o.signal);
    const narration = await cachedNarration(script, voice, speed, o.signal);
    const { duration, stepDone } = await player.load(narration.steps.map((step) => timing(step, captions)));
    const timingNote =
      !narration.total ? "timing exact: the script has no narration" : narration.cached === narration.total && narration.voice
        ? `timing from the speech of ${narration.voice}, as the video will have it`
        : narration.cached
          ? `timing from cached speech for ${narration.cached} of ${narration.total} sentences, the rest estimated`
          : "timing estimated: timestamps can shift by several seconds when the narration is rendered";
    const files: { file: string; shows: string }[] = [];

    if (o.at !== undefined) {
      const at = Math.min(Math.max(0, o.at), duration);
      // the first frame of a fresh page always comes back
      const frame = await player.frame(at);
      if (!frame) throw new Error("The player did not produce a snapshot frame.");
      await writeFile(path.join(work, "0.png"), frame, { signal: o.signal });
      files.push({ file: o.output, shows: `the video at ${at.toFixed(1)} s` });
    } else {
      for (const [i, part] of pages.entries()) {
        o.signal?.throwIfAborted();
        const file = outputs[i];
        const staged = path.join(work, `${i}.png`);
        if (o.sheet) {
          await writeFile(staged, await player.sheet(part, Math.min(SHEET_COLUMNS, part.length), o.width ?? SHEET_TILE), { signal: o.signal });
          files.push({ file, shows: `steps ${part.join(", ")}, each as it is done` });
        } else {
          const step = part[0];
          await writeFile(staged, await player.stepFrame(step, true), { signal: o.signal });
          files.push({ file, shows: `step ${step} done, at ${stepDone[step - 1].toFixed(1)} s` });
        }
      }
    }
    o.signal?.throwIfAborted();
    for (const [i, file] of files.entries()) await publishFile(path.join(work, `${i}.png`), file.file);
    return { files, timing: timingNote };
  } catch (error) {
    o.signal?.throwIfAborted();
    throw error;
  } finally {
    try { await player?.close(); } finally { await rm(work, { recursive: true, force: true }); }
  }
}
