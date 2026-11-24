/** The two things a script can be turned into: a video, and a still picture of one moment. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { check, type Report } from "../format/check.ts";
import { cacheDir } from "../paths.ts";
import type { LoadRequest } from "../player/main.ts";
import { DEFAULT_CANVAS, OUTPUT_SCALE, type Script } from "../shared/types.ts";
import { type Narration, SAMPLE_RATE, estimateNarration, narrate } from "../voice/narrate.ts";
import { resolveVoice } from "../voice/voice.ts";
import { writeWav } from "../voice/wav.ts";
import { startEncoder } from "./encode.ts";
import { openPlayer } from "./player.ts";

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
    throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
  const report = check(parsed, baseDir);
  if (report.errors.length) throw new ScriptError(report);
  return { script: parsed as Script, baseDir, report };
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

async function playerRequest(loaded: Loaded, narration: Narration, width: number | undefined, captions: boolean): Promise<LoadRequest> {
  const { script, baseDir } = loaded;
  const canvas = { ...DEFAULT_CANVAS, ...script.canvas };
  const outWidth = Math.round(width ?? canvas.width * OUTPUT_SCALE);
  const sources = new Set(script.steps.flatMap((s) => s.do ?? []).flatMap((a) => (a.add ? [a.add].flat() : [])).map((el) => el.src).filter((s): s is string => !!s));
  const images: Record<string, string> = {};
  for (const src of sources) {
    const data = await readFile(path.resolve(baseDir, src));
    images[src] = `data:${IMAGE_MIME[path.extname(src).toLowerCase()]};base64,${data.toString("base64")}`;
  }
  return {
    script,
    images,
    audio: narration.steps.map((s) => s && (captions ? s : { ...s, captions: [] })),
    output: { width: outWidth, height: Math.round((outWidth * canvas.height) / canvas.width) },
  };
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
  o.log("Narration");
  const narration = await narrate(script, voice, o.speed ?? script.speed ?? 1, o.log);

  const player = await openPlayer(await playerRequest(loaded, narration, o.width, o.captions ?? script.captions ?? true), o.log);
  const audioFile = path.join(cacheDir(), "tmp", `narration-${process.pid}.wav`);
  try {
    const { duration, stepStarts } = player.info;
    const track = new Float32Array(Math.ceil(duration * SAMPLE_RATE));
    narration.clips.forEach((clip, i) => {
      if (!clip) return;
      const at = Math.round(stepStarts[i] * SAMPLE_RATE);
      track.set(clip.samples.subarray(0, Math.max(0, track.length - at)), at);
    });
    await mkdir(path.dirname(audioFile), { recursive: true });
    await writeWav(audioFile, { samples: track, sampleRate: SAMPLE_RATE });
    await mkdir(path.dirname(path.resolve(o.output)), { recursive: true });

    const frames = Math.ceil(duration * o.fps);
    o.log(`Video: ${duration.toFixed(1)} s, ${frames} frames`);
    const encoder = startEncoder({ output: o.output, fps: o.fps, audio: audioFile });
    let last: Buffer | null = null;
    let shown = 0;
    for (let i = 0; i < frames; i++) {
      last = (await player.frame(i / o.fps)) ?? last;
      await encoder.write(last!);
      const percent = Math.floor(((i + 1) / frames) * 10) * 10;
      if (percent > shown) o.log(`  ${(shown = percent)}%`);
    }
    await encoder.finish();
    return { duration };
  } finally {
    await player.close();
    await rm(audioFile, { force: true });
  }
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
  const player = await openPlayer(await playerRequest(loaded, estimateNarration(loaded.script), o.width, loaded.script.captions ?? true), o.log);
  try {
    const { duration, stepStarts } = player.info;
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
