/** The two things a script can be turned into: a video, and a still picture of one moment. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { check, type Report } from "../format/check.ts";
import { cacheDir } from "../paths.ts";
import type { PrepareRequest } from "../player/main.ts";
import { segmentFrames } from "../shared/h264.ts";
import { DEFAULT_CANVAS, type Formula, OUTPUT_SCALE, type Script, type StepAudio } from "../shared/types.ts";
import { type Listener, SAMPLE_RATE, estimateNarration, narrate } from "../voice/narrate.ts";
import { resolveVoice } from "../voice/voice.ts";
import { type Audio, pcm16, writeWav } from "../voice/wav.ts";
import { type Output, startEncoder, startMuxer } from "./encode.ts";
import { type Player, openPlayer } from "./player.ts";

type Log = (line: string) => void;

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
  baseDir: string;
  report: Report;
}

export async function loadScript(file: string): Promise<Loaded> {
  const baseDir = path.dirname(path.resolve(file));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    const { message } = e as Error;
    // LaTeX is full of backslashes, and JSON takes one as the start of an escape
    const hint = /escape/i.test(message) ? `. In JSON a backslash is written twice: "\\\\alpha", not "\\alpha".` : "";
    throw new Error(`Could not read ${file}: ${message}${hint}`);
  }
  const report = await check(parsed, baseDir);
  if (report.errors.length) throw new ScriptError(report);
  return { script: parsed as Script, baseDir, report };
}

/** Every formula the script draws, typeset and keyed by its LaTeX. */
export async function typesetFormulas(script: Script): Promise<Record<string, Formula>> {
  const actions = script.steps.flatMap((s) => s.do ?? []);
  const sources = [...actions.flatMap((a) => (a.add ? [a.add].flat() : [])), ...actions.flatMap((a) => (a.update ? [a.update] : []))].map((spec) => spec.tex).filter((tex): tex is string => !!tex);
  if (!sources.length) return {};
  const { typeset } = await import("../math/typeset.ts");
  return Object.fromEntries(sources.map((tex) => [tex, typeset(tex)]));
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** DRAWCAST_ENCODER=ffmpeg turns the browser's encoder down, to compare the two ways or to get past one that misbehaves. */
const browserMayEncode = () => process.env.DRAWCAST_ENCODER !== "ffmpeg";

/**
 * What the player page needs before any timing is known. For a video, `fps` is given: the size is then
 * rounded up to what H.264 can hold, and the page is asked to look for its encoder.
 */
async function playerRequest(loaded: Loaded, width: number | undefined, fps?: number): Promise<PrepareRequest> {
  const { script, baseDir } = loaded;
  const canvas = { ...DEFAULT_CANVAS, ...script.canvas };
  const outWidth = Math.round(width ?? canvas.width * OUTPUT_SCALE);
  const outHeight = Math.round((outWidth * canvas.height) / canvas.width);
  const sources = new Set(script.steps.flatMap((s) => s.do ?? []).flatMap((a) => (a.add ? [a.add].flat() : [])).map((el) => el.src).filter((s): s is string => !!s));
  const images: Record<string, string> = {};
  for (const src of sources) {
    const data = await readFile(path.resolve(baseDir, src));
    images[src] = `data:${IMAGE_MIME[path.extname(src).toLowerCase()]};base64,${data.toString("base64")}`;
  }
  const math = await typesetFormulas(script);
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
  whole: Promise<{ duration: number; frames: number }>;
}

/**
 * Starts the narration (`narrate` is given who to report each step to), tells the page of the steps as
 * they arrive, and keeps account of what that settles.
 */
export function tell(opening: Promise<Player>, script: Script, narrate: (listener: Listener) => Promise<unknown>, o: { fps: number; captions: boolean; log: Log }): Telling {
  let steps: (StepAudio | null)[] = [];
  let clips: (Audio | null)[] = [];
  const spoken = signal();
  const settled = signal();
  let stepStarts: number[] = [];
  let frames = 0;
  let samples = 0;
  let duration: number | null = null;
  let round = 0;
  let failure: unknown = null;

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
      duration = null;
      spoken.fire();
      settled.fire();
    },
  });
  // a failure is seen by the loop below, the next time it waits for a step
  narrating.catch(() => {});

  const whole = (async () => {
    const player = await opening;
    // the round the page's timeline is of, and how many of that round's steps the page has been told
    let paged = 0;
    let told = 0;
    while (paged !== round || told < script.steps.length) {
      if (paged !== round) {
        // the page forgets the first voice's timing too
        paged = round;
        told = 0;
        await player.startOver();
        continue;
      }
      if (steps.length === told) {
        // woken by a step being spoken, by starting over, or by the narration failing
        await Promise.race([spoken.wait(), narrating]);
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
      duration = schedule.duration;
      if (duration !== null) o.log(`Video: ${duration.toFixed(1)} s, ${frames} frames`);
      settled.fire();
    }
    return { duration: duration!, frames };
  })();
  whole.catch((e) => {
    failure = e;
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
  };
}

/**
 * The quick way to the file: the browser's own encoder makes the H.264 in the page, in segments that
 * several encoders share, and ffmpeg only wraps the result, taking the narration in as it is spoken.
 * A segment is made as soon as all of its frames are settled. `guess` is about how many frames there
 * will be, to choose the length of a segment before the length of the video is known.
 *
 * False when this browser cannot do it, and then the player is still open for the other way. Either way
 * closes the player once the frames are out.
 */
export async function recordInBrowser(player: Player, telling: Telling, o: Output & { guess: number; log: Log }): Promise<boolean> {
  if (!browserMayEncode()) return false;
  // the page has been looking for its encoder since it opened
  const { encoder: info, tried } = await player.encoder().catch((e: Error) => ({ encoder: null, tried: [e.message.split("\n")[0]] }));
  if (!info) {
    o.log("  This browser has no H.264 encoder to use, so ffmpeg encodes frame by frame, which takes several times longer.");
    for (const line of tried) o.log(`    ${line}`);
    return false;
  }

  // Once round, unless the narration starts over in another voice: then what was made is thrown away,
  // and the video is made again from what that voice says.
  for (;;) {
    const round = telling.round;
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
    /** the frames of each segment handed out so far */
    const counts: number[] = [];
    let next = 0; // the first frame that is in no segment yet
    const made = new Map<number, Buffer>();
    let written = 0;
    let done = 0;
    let report: ((done: number) => void) | undefined;

    /** The next segment to make, once every frame of it is settled; null when there are no more to make. */
    const take = async (): Promise<{ index: number; first: number; count: number } | null> => {
      for (;;) {
        if (ended()) return null;
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
        made.set(segment.index, await player.encodeSegment(lane, segment.first, segment.count));
        await (writing = writing.then(write));
      }
    };
    // the sound goes to ffmpeg as it settles, so that it is encoded along the way and not all at the end
    const sound = async () => {
      for (let sent = 0; !ended(); await news()) {
        const upTo = telling.samples;
        if (upTo > sent) muxer.sound(pcm16(telling.sound(sent, upTo)));
        sent = upTo;
        if (telling.duration !== null) return;
      }
    };
    // One that breaks stops the others, and all of them are waited for: a lane is in the middle of a
    // segment in the page, and must be out of it before anything else is asked of that lane.
    const ending = async (work: Promise<void>) => {
      try {
        await work;
      } catch (e) {
        over = true;
        stop();
        throw e;
      }
    };
    const outcome = await Promise.allSettled([sound(), ...Array.from({ length: info.lanes }, (_, lane) => work(lane))].map(ending));
    const broken = outcome.find((result) => result.status === "rejected");

    if (!broken && telling.round === round) {
      // the browser has nothing left to do, and closes while ffmpeg finishes the file
      await Promise.all([muxer.finish(), player.close()]);
      return true;
    }
    await muxer.abort();
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

/** The way that always works: every frame leaves the browser as a PNG and ffmpeg encodes the lot. */
export async function recordWithFfmpeg(player: Player, o: Output & { audio: string; frames: number; log: Log }): Promise<void> {
  const encoder = startEncoder(o);
  const report = progress(o.frames, o.log);
  try {
    let last: Buffer | null = null;
    for (let i = 0; i < o.frames; i++) {
      last = (await player.frame(i / o.fps)) ?? last;
      await encoder.write(last!);
      report(i + 1);
    }
  } catch (e) {
    await encoder.abort();
    throw e;
  }
  await Promise.all([encoder.finish(), player.close()]);
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
  log: Log;
}

export async function renderVideo(loaded: Loaded, o: RenderOptions): Promise<{ duration: number }> {
  const { script } = loaded;
  const voice = await resolveVoice({
    spec: o.voice ?? script.voice,
    narration: script.steps.map((s) => s.say ?? "").join(" "),
    ttsCommand: o.ttsCommand,
    log: o.log,
  });
  await mkdir(path.dirname(path.resolve(o.output)), { recursive: true });
  // The browser starts, and loads the page with its fonts and images, while the narration is spoken.
  const opening = openPlayer(await playerRequest(loaded, o.width, o.fps), o.log);
  opening.catch(() => {});
  o.log("Narration");
  // And the video is drawn behind the narration, as far as it has been spoken.
  const telling = tell(opening, script, (listener) => narrate(script, voice, o.speed ?? script.speed ?? 1, o.log, listener), {
    fps: o.fps,
    captions: o.captions ?? script.captions ?? true,
    log: o.log,
  });

  const player = await opening;
  const audioFile = path.join(cacheDir(), "tmp", `narration-${process.pid}.wav`);
  try {
    const job = { output: o.output, fps: o.fps, log: o.log };
    if (!(await recordInBrowser(player, telling, { ...job, guess: guessFrames(script, o.fps) }))) {
      // the slow way takes the narration whole, from a file
      const { duration, frames } = await telling.whole;
      await mkdir(path.dirname(audioFile), { recursive: true });
      await writeWav(audioFile, { samples: telling.sound(0, telling.samples), sampleRate: SAMPLE_RATE });
      await recordWithFfmpeg(player, { ...job, audio: audioFile, frames });
    }
    return { duration: (await telling.whole).duration };
  } finally {
    await player.close();
    await rm(audioFile, { force: true });
  }
}

/** About how many frames a video will have, going by the length of what is said: enough to choose a segment's length by. */
function guessFrames(script: Script, fps: number): number {
  const seconds = estimateNarration(script).steps.reduce((total, step, i) => total + (step?.duration ?? script.steps[i].duration ?? 1) + 0.5, 1.5);
  return Math.ceil(seconds * fps);
}

export interface SnapshotOptions {
  output: string;
  /** seconds into the video; left out, the last frame */
  at?: number;
  /** instead of `at`: the picture as this step (1-based) ends */
  step?: number;
  width?: number;
  log: Log;
}

/** A PNG of one moment. Nothing is spoken: timing is estimated, which is close enough to judge a layout. */
export async function renderSnapshot(loaded: Loaded, o: SnapshotOptions): Promise<{ at: number }> {
  const player = await openPlayer(await playerRequest(loaded, o.width), o.log);
  try {
    const captions = loaded.script.captions ?? true;
    const { duration, stepStarts } = await player.load(estimateNarration(loaded.script).steps.map((step) => timing(step, captions)));
    let at = Math.min(o.at ?? duration, duration);
    if (o.step !== undefined) {
      if (o.step < 1 || o.step > stepStarts.length) throw new Error(`--step must be between 1 and ${stepStarts.length}.`);
      // just before the next step begins, when this one's strokes have landed
      at = o.step < stepStarts.length ? stepStarts[o.step] - 0.05 : duration;
    }
    const png = await player.frame(at);
    await mkdir(path.dirname(path.resolve(o.output)), { recursive: true });
    await writeFile(o.output, png!);
    return { at };
  } finally {
    await player.close();
  }
}
