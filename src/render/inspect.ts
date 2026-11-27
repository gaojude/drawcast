import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { prepareOutputFiles, publishFile } from "../shared/files.ts";
import { parseSteps, SHEET_COLUMNS, SHEET_STEPS, SHEET_TILE, sheetPage } from "../shared/steps.ts";
import { requireFfmpeg } from "./encode.ts";
import { readStepIndex } from "./step-index.ts";

const exec = promisify(execFile);

/** Packet timestamps give the video track's exact clock, including its final frame interval. */
async function readTimeline(file: string, keepStarts: boolean, signal?: AbortSignal) {
  const stream = createReadStream(file, { signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const starts: number[] = [];
  let ticksPerSecond = 0;
  let frames = 0;
  let first = Infinity;
  let end = -Infinity;
  let dimensions: string | undefined;
  let audioCodec: string | undefined;
  try {
    for await (const line of lines) {
      if (line.startsWith("#tb 0:")) {
        const [n, d] = line.slice(6).trim().split("/").map(Number);
        ticksPerSecond = d / n;
      } else if (line.startsWith("#dimensions 0:")) {
        dimensions = line.slice(line.indexOf(":") + 1).trim();
      } else if (line.startsWith("#codec_id 1:")) {
        audioCodec = line.slice(line.indexOf(":") + 1).trim();
      } else if (line.startsWith("0,")) {
        const [, , pts, duration] = line.split(",", 4).map(Number);
        if (keepStarts) starts.push(pts);
        frames++;
        first = Math.min(first, pts);
        end = Math.max(end, pts + duration);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!frames || !(ticksPerSecond > 0) || !Number.isFinite(end)) throw new Error("The MP4 has no timed video frames.");
  // H.264 with B-frames stores packets in decode order. The select filter sees display order.
  starts.sort((a, b) => a - b);
  return { starts, frames, ticksPerSecond, duration: (end - first) / ticksPerSecond, dimensions, audioCodec };
}

/** Keep the opening and ending, then find up to four separated moments of sustained visual change. */
async function motionFrames(file: string, times: number[], signal?: AbortSignal): Promise<number[]> {
  const stream = createReadStream(file, { signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const scores: number[] = [];
  let previous = 0;
  try {
    for await (const line of lines) {
      if (!line.startsWith("lavfi.signalstats.YDIF=")) continue;
      const change = Number(line.slice(line.indexOf("=") + 1));
      // A one-frame cut (including a cover) has a large difference on only one side.
      scores.push(Math.min(change, previous));
      previous = change;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (scores.length !== times.length) throw new Error("The decoded motion frames do not match the MP4 timeline.");
  const peaks: number[] = [];
  const separation = Math.min(1, times.at(-1)! / 8);
  while (peaks.length < 4) {
    let best = -1;
    for (let i = 1; i < scores.length - 1; i++) {
      if (!(scores[i] > 0) || (best >= 0 && scores[i] <= scores[best])) continue;
      if (peaks.every(j => j !== i && Math.abs(times[j] - times[i]) >= separation)) best = i;
    }
    if (best < 0) break;
    peaks.push(best);
  }
  return [0, ...peaks.sort((a, b) => a - b), times.length - 1];
}

interface InspectOptions {
  at?: number | number[];
  signal?: AbortSignal;
  motion?: boolean;
  width?: number;
  step?: string;
}

export async function inspectVideo(input: string, output: string, { at, signal, motion, width, step }: InspectOptions = {}) {
  signal?.throwIfAborted();
  if (width !== undefined && (!Number.isSafeInteger(width) || width < 1)) throw new Error("--width must be a positive integer in pixels.");
  if (Number(at !== undefined) + Number(!!motion) + Number(step !== undefined) > 1) throw new Error("Choose --motion, --at, or --step on its own.");
  const requested = at === undefined ? undefined : [at].flat();
  if (requested?.some(s => !Number.isFinite(s) || s < 0)) throw new Error("--at must be a nonnegative number of seconds.");
  if (requested && (!requested.length || requested.length > 12)) throw new Error("--at accepts one to twelve times.");
  const index = step === undefined ? undefined : await readStepIndex(input, signal);
  const stepsByFrame = new Map<number, number[]>();
  if (index) {
    for (const n of parseSteps(step!, index.stepFrames.length).sort((a, b) => a - b)) {
      // The final hold shows what the viewer is left with after narration and captions.
      const frame = n === index.stepFrames.length ? index.frames - 1 : index.stepFrames[n - 1];
      if (!stepsByFrame.has(frame)) stepsByFrame.set(frame, []);
      stepsByFrame.get(frame)!.push(n);
    }
  }
  const pages = Math.max(1, Math.ceil(stepsByFrame.size / SHEET_STEPS));
  const outputs = Array.from({ length: pages }, (_, i) => pages === 1 ? output : sheetPage(output, i));
  await prepareOutputFiles([input], outputs, "input MP4");
  const ffmpeg = requireFfmpeg();
  const work = await mkdtemp(path.join(path.dirname(path.resolve(output)), ".drawcast-"));
  const source = ["-nostdin", "-hide_banner", "-v", "error", "-xerror", "-f", "mov", "-i", path.resolve(input), "-map", "0:V:0"];
  const options = { windowsHide: true, signal, killSignal: "SIGKILL" as const };
  try {
    const metadata = path.join(work, "packets.txt");
    await exec(ffmpeg, [...source, "-map", "0:a:0?", "-c", "copy", "-f", "framecrc", metadata], options);
    const { starts, frames, ticksPerSecond, duration, dimensions, audioCodec } = await readTimeline(metadata, !index, signal);
    if (index && index.frames !== frames) throw new Error("The Drawcast step index and the encoded frame count differ. Use --at or --motion, or render the script again.");
    if (requested?.some(s => s >= duration)) throw new Error(`--at must be less than the video duration (${Number(duration.toFixed(6))} s).`);
    const seconds = (i: number) => (starts[i] - starts[0]) / ticksPerSecond;
    const count = Math.min(6, starts.length);
    let indices = index ? [...stepsByFrame.keys()] : requested
      ? [...new Set(requested.map(s => starts.findLastIndex((_, i) => seconds(i) <= s)))].sort((a, b) => a - b)
      : Array.from({ length: count }, (_, i) => Math.round(i * (starts.length - 1) / Math.max(1, count - 1)));
    if (motion && starts.length > count) {
      // Score a small image above the caption strip. Export the selected original frames with captions.
      const filter = "scale=160:90,crop=160:76:0:0,format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=motion.txt";
      await exec(ffmpeg, [...source, "-vf", filter, "-f", "null", "-"], { ...options, cwd: work });
      indices = await motionFrames(path.join(work, "motion.txt"), starts.map((_, i) => seconds(i)), signal);
    }

    const selected = indices.map((i) => `eq(n\\,${i})`).join("+");
    const perPage = Math.min(indices.length, SHEET_STEPS);
    const columns = Math.min(perPage, SHEET_COLUMNS);
    const filters = [`select=${selected}`];
    if (index) {
      // Record PTS from decoded frames, before the sheet filter changes their timestamps.
      filters.push("metadata=mode=add:key=drawcast:value=1", "metadata=print:key=drawcast:file=times.txt");
    }
    const sheet = index ? indices.length > 1 : requested?.length !== 1;
    if (sheet || width !== undefined) filters.push(`scale=${width ?? SHEET_TILE}:-1`);
    if (sheet) filters.push(`tile=${columns}x${Math.ceil(perPage / columns)}:nb_frames=${perPage}:padding=4:margin=4:color=white`);
    // A filter file keeps large step selections out of the platform's command-line limit.
    await writeFile(path.join(work, "filter.txt"), filters.join(","), { signal });
    await exec(ffmpeg, [...source, "-filter_script:v", "filter.txt", "-vsync", "0", "-frames:v", String(pages), "-abort_on", "empty_output", "preview-%d.png"], { ...options, cwd: work });
    const times = index
      ? [...(await readFile(path.join(work, "times.txt"), { encoding: "utf8", signal })).matchAll(/^frame:\s*\d+\s+pts:\s*(-?\d+)/gm)].map(m => Number(m[1]) / ticksPerSecond)
      : indices.map(seconds);
    if (times.length !== indices.length) throw new Error("The selected step frames could not all be decoded. Use --at or --motion, or render the script again.");
    const files = outputs.map((file, i) => {
      const begin = i * perPage;
      return { file, times: times.slice(begin, begin + perPage), steps: index ? indices.slice(begin, begin + perPage).map(n => stepsByFrame.get(n)!) : undefined };
    });
    signal?.throwIfAborted();
    for (const [i, file] of outputs.entries()) await publishFile(path.join(work, `preview-${i + 1}.png`), file);
    return { files, duration, frames, dimensions, audioCodec };
  } catch (error) {
    signal?.throwIfAborted();
    const diagnostic = (error as { stderr?: string }).stderr?.trim();
    if (diagnostic) throw new Error(`Could not inspect ${input}: ${diagnostic}`);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
