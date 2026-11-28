/** The two things a script can be turned into: a video, and a still picture of one moment. */
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { check, type Report } from "../format/check.ts";
import { expand, type ResolvedGeometry } from "../format/expand.ts";
import { axesImageKey, axesSvg } from "../shared/axes.ts";
import type { PrepareRequest } from "../player/main.ts";
import { segmentFrames } from "../shared/h264.ts";
import { prepareOutputFiles, publishFile, writeFileAtomic } from "../shared/files.ts";
import { importNarration, narrationRequest } from "../narration/manifest.ts";
import { DEFAULT_CANVAS, type Formula, imageKey, OUTPUT_SCALE, type Script, type StepAudio } from "../shared/types.ts";
import { SAMPLE_RATE, estimateNarration } from "../narration/timing.ts";
import { type Audio, pcm16 } from "../narration/wav.ts";
import { type Output, requireFfmpeg, startEncoder, startMuxer } from "./encode.ts";
import { type Player, openPlayer } from "./player.ts";
import { appendStepIndex, stepFrameIndex } from "./step-index.ts";
import { parseSteps, SHEET_COLUMNS, SHEET_STEPS, SHEET_TILE, sheetPage } from "../shared/steps.ts";
export { parseSteps } from "../shared/steps.ts";

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
const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** DRAWCAST_ENCODER=ffmpeg turns the browser's encoder down, to compare the two ways or to get past one that misbehaves. */
const browserMayEncode = () => process.env.DRAWCAST_ENCODER !== "ffmpeg";

function imageSources(script: Script): Set<string> {
  return new Set(script.steps.flatMap((s) => s.do ?? []).flatMap((a) => a.add ? [a.add].flat() : []).map((el) => el.src).filter((s): s is string => !!s));
}

async function prepareOutputs(loaded: Loaded, outputs: string[], narrationInputs: string[] = []) {
  const inputs = [loaded.sourceFile, ...Array.from(imageSources(loaded.script), (src) => path.resolve(loaded.baseDir, src))];
  await prepareOutputFiles([...inputs, ...narrationInputs], outputs, narrationInputs.length ? "input script, images and narration files" : "input script and its images");
}

export async function exportNarration(loaded: Loaded, output: string) {
  await prepareOutputs(loaded, [output]);
  await writeFileAtomic(output, Buffer.from(JSON.stringify(narrationRequest(loaded.script), null, 2) + "\n"));
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
      if (el.type === "axes") images[axesImageKey(el.id)] = svgDataUrl(axesSvg(el));
      if (el.type === "image" && el.svg !== undefined) images[imageKey(el)] = svgDataUrl(el.svg);
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

type VideoJob = Output & { audio: string; pcmRate: number; frames: number; cover: number | null; log: Log };

/** Compile at most one segment per encoder lane in parallel, and mux them in frame order. */
export async function recordInBrowser(player: Player, job: VideoJob): Promise<boolean> {
  if (!browserMayEncode()) return false;
  const { encoder } = await player.encoder().catch(() => ({ encoder: null }));
  job.signal?.throwIfAborted();
  if (!encoder) return false;
  const muxer = startMuxer({ ...job, color: encoder.color });
  const size = segmentFrames(job.frames, job.fps, encoder.lanes);
  const report = progress(job.frames, job.log);
  try {
    let next = 0;
    while (next < job.frames) {
      const batch: Promise<Buffer>[] = [];
      for (let lane = 0; lane < encoder.lanes && next < job.frames; lane++) {
        const cover = next === 0 ? job.cover ?? undefined : undefined;
        const count = cover === undefined ? Math.min(size, job.frames - next) : 1;
        batch.push(player.encodeSegment(lane, next, count, cover));
        next += count;
      }
      // Wait for every lane before returning the page to the fallback encoder.
      for (const result of await Promise.allSettled(batch)) {
        if (result.status === "rejected") throw result.reason;
        if (!result.value.length) throw new Error("The browser returned an empty video segment.");
        await muxer.write(result.value);
      }
      report(next);
    }
    await muxer.finish();
    return true;
  } catch (error) {
    await muxer.abort();
    job.signal?.throwIfAborted();
    await player.stopEncoding().catch(() => {});
    job.log("Browser encoding failed, retrying with ffmpeg: " + (error as Error).message);
    return false;
  }
}

/**
 * The way that always works: every frame leaves the browser as a PNG and ffmpeg encodes the lot. With
 * `cover`, the first frame is the canvas at that time instead of the empty one.
 */
export async function recordWithFfmpeg(player: Player, o: VideoJob): Promise<void> {
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
  await encoder.finish();
}

export interface RenderOptions {
  narration?: string;
  output: string;
  fps: number;
  /** output width in pixels; the height follows from the canvas */
  width?: number;
  captions?: boolean;
  signal?: AbortSignal;
  log: Log;
}

export async function renderVideo(loaded: Loaded, o: RenderOptions): Promise<{ duration: number }> {
  const { script } = loaded;
  const { signal, fps } = o;
  signal?.throwIfAborted();
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("--fps must be a positive frame rate.");
  if (!o.narration && script.steps.some(step => step.say?.trim())) {
    throw new Error("Spoken steps need --narration result.json. Run drawcast narration export, generate WAVs with your TTS tool, then render. See drawcast guide narration.");
  }
  const imported = o.narration ? await importNarration(script, o.narration, true, signal) : undefined;
  await prepareOutputs(loaded, [o.output], imported?.inputs);
  const ffmpeg = requireFfmpeg();
  const captions = o.captions ?? script.captions ?? true;
  const request = await playerRequest(loaded, o.width, captions, fps, signal);
  const work = await mkdtemp(path.join(path.dirname(path.resolve(o.output)), ".drawcast-"));
  let player: Player | undefined;
  try {
    player = await openPlayer(request, o.log, signal);
    const audio = imported?.steps ?? script.steps.map(() => null);
    const { duration, stepStarts, stepDone } = await player.load(audio.map(step => timing(step, captions)));
    const frames = Math.ceil(duration * fps);
    const samples = Math.ceil(duration * SAMPLE_RATE);
    if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(samples * 2)) throw new Error("The timeline is too long to encode.");
    const cover = script.cover === false ? null : script.cover ?? 1;
    const job = { ffmpeg, output: path.join(work, "video.mp4"), audio: path.join(work, "audio.pcm"), pcmRate: SAMPLE_RATE, frames, fps, cover, signal, log: o.log };
    o.log(`Video: ${duration.toFixed(1)} s, ${frames} frames`);
    await writeAudio(job.audio, samples, stepStarts, imported?.clips ?? [], signal);
    if (!await recordInBrowser(player, job)) await recordWithFfmpeg(player, job);
    await appendStepIndex(job.output, stepFrameIndex(stepStarts, stepDone, fps, frames, cover !== null), signal);
    await publishFile(job.output, o.output, signal);
    return { duration };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    try { await player?.close(); } finally { await rm(work, { recursive: true, force: true }); }
  }
}

/** Gaps and holds stay silent. Write each recorded step at its scheduled sample offset. */
async function writeAudio(file: string, samples: number, starts: number[], clips: (Audio | null)[], signal?: AbortSignal) {
  const output = await open(file, "w");
  try {
    await output.truncate(samples * 2);
    for (const [i, clip] of clips.entries()) {
      if (!clip) continue;
      const start = Math.round(starts[i] * SAMPLE_RATE);
      for (let from = 0; from < clip.samples.length; from += SAMPLE_RATE) {
        signal?.throwIfAborted();
        const data = pcm16(clip.samples.subarray(from, from + SAMPLE_RATE));
        for (let offset = 0; offset < data.length;) {
          const { bytesWritten } = await output.write(data, offset, data.length - offset, (start + from) * 2 + offset);
          offset += bytesWritten;
        }
      }
    }
  } finally {
    await output.close();
  }
}

export interface SnapshotOptions {
  narration?: string;
  /** the file to write; with several pictures, each gets a suffix before the extension */
  output: string;
  /** seconds into the video, with pointer and captions as the video shows them */
  at?: number;
  /** instead of `at`: the steps (1-based) to show, each as it is done. Left out, the last step. */
  steps?: number[];
  /** the steps on one picture, in a grid, instead of a picture each */
  sheet?: boolean;
  width?: number;
  captions?: boolean;
  signal?: AbortSignal;
  log: Log;
}

/**
 * Stills use recorded timings when supplied, or estimated timings for a layout preview.
 */
export async function renderSnapshot(loaded: Loaded, o: SnapshotOptions): Promise<{ files: { file: string; shows: string }[]; timing: string }> {
  o.signal?.throwIfAborted();
  const { script } = loaded;
  const canvas = { ...DEFAULT_CANVAS, ...script.canvas };
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
  const imported = o.narration ? await importNarration(script, o.narration, false, o.signal) : undefined;
  await prepareOutputs(loaded, outputs, imported?.inputs);
  const captions = o.captions ?? script.captions ?? true;
  // a still is looked at, not watched: the canvas's own size is plenty, and quicker to make and to read
  const request = await playerRequest(loaded, o.width ?? Math.round(canvas.width), captions, undefined, o.signal);
  const work = await mkdtemp(path.join(path.dirname(path.resolve(o.output)), ".drawcast-"));
  let player: Player | undefined;
  try {
    player = await openPlayer(request, o.log, o.signal);
    const narration = imported ?? estimateNarration(script);
    const { duration, stepDone } = await player.load(narration.steps.map(step => timing(step, captions)));
    const timingNote = imported ? "timing from imported narration" : narration.steps.some(Boolean)
      ? "timing estimated: pass --narration for recorded timings" : "timing exact: the script has no narration";
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
