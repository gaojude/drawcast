import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { prepareOutputFiles, publishFile } from "../shared/files.ts";
import { requireFfmpeg } from "./encode.ts";

const exec = promisify(execFile);

/** Packet timestamps give the video track's exact clock, including its final frame interval. */
async function readTimeline(file: string, signal?: AbortSignal) {
  const stream = createReadStream(file, { signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const starts: number[] = [];
  let ticksPerSecond = 0;
  let end = -Infinity;
  try {
    for await (const line of lines) {
      if (line.startsWith("#tb 0:")) {
        const [n, d] = line.slice(6).trim().split("/").map(Number);
        ticksPerSecond = d / n;
      } else if (line.startsWith("0,")) {
        const [, , pts, duration] = line.split(",", 4).map(Number);
        starts.push(pts);
        end = Math.max(end, pts + duration);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!starts.length || !(ticksPerSecond > 0) || !Number.isFinite(end)) throw new Error("The MP4 has no timed video frames.");
  // H.264 with B-frames stores packets in decode order. The select filter sees display order.
  starts.sort((a, b) => a - b);
  return { starts, ticksPerSecond, duration: (end - starts[0]) / ticksPerSecond };
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

export async function inspectVideo(input: string, output: string, at?: number | number[], signal?: AbortSignal, motion = false): Promise<number[]> {
  signal?.throwIfAborted();
  if (at !== undefined && motion) throw new Error("Choose --motion for automatic selection or --at for specific times.");
  const requested = at === undefined ? undefined : [at].flat();
  if (requested?.some(s => !Number.isFinite(s) || s < 0)) throw new Error("--at must be a nonnegative number of seconds.");
  if (requested && (!requested.length || requested.length > 12)) throw new Error("--at accepts one to twelve times.");
  await prepareOutputFiles([input], [output], "input MP4");
  const ffmpeg = requireFfmpeg();
  const work = await mkdtemp(path.join(path.dirname(path.resolve(output)), ".drawcast-"));
  const source = ["-nostdin", "-hide_banner", "-v", "error", "-xerror", "-f", "mov", "-i", path.resolve(input), "-map", "0:V:0"];
  const options = { windowsHide: true, signal, killSignal: "SIGKILL" as const };
  try {
    const metadata = path.join(work, "packets.txt");
    await exec(ffmpeg, [...source, "-c:v", "copy", "-f", "framecrc", metadata], options);
    const { starts, ticksPerSecond, duration } = await readTimeline(metadata, signal);
    if (requested?.some(s => s >= duration)) throw new Error(`--at must be less than the video duration (${Number(duration.toFixed(6))} s).`);
    const seconds = (i: number) => (starts[i] - starts[0]) / ticksPerSecond;
    const count = Math.min(6, starts.length);
    let indices = requested
      ? [...new Set(requested.map(s => starts.findLastIndex((_, i) => seconds(i) <= s)))].sort((a, b) => a - b)
      : Array.from({ length: count }, (_, i) => Math.round(i * (starts.length - 1) / Math.max(1, count - 1)));
    if (motion && starts.length > count) {
      // Score a small image above the caption strip. Export the selected original frames with captions.
      const filter = "scale=160:90,crop=160:76:0:0,format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=motion.txt";
      await exec(ffmpeg, [...source, "-vf", filter, "-f", "null", "-"], { ...options, cwd: work });
      indices = await motionFrames(path.join(work, "motion.txt"), starts.map((_, i) => seconds(i)), signal);
    }

    const selected = indices.map((i) => `eq(n\\,${i})`).join("+");
    const columns = Math.min(indices.length, 3);
    const filter = requested?.length !== 1
      ? `select=${selected},scale=512:-1,tile=${columns}x${Math.ceil(indices.length / columns)}:nb_frames=${indices.length}:padding=4:margin=4:color=white`
      : `select=${selected}`;
    const staged = path.join(work, "preview.png");
    await exec(ffmpeg, [...source, "-vf", filter, "-frames:v", "1", "-abort_on", "empty_output", "-update", "1", staged], options);
    await publishFile(staged, output, signal);
    return indices.map(seconds);
  } catch (error) {
    signal?.throwIfAborted();
    const diagnostic = (error as { stderr?: string }).stderr?.trim();
    if (diagnostic) throw new Error(`Could not inspect ${input}: ${diagnostic}`);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
