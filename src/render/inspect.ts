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

export async function inspectVideo(input: string, output: string, at?: number, signal?: AbortSignal): Promise<number[]> {
  signal?.throwIfAborted();
  if (at !== undefined && (!Number.isFinite(at) || at < 0)) throw new Error("--at must be a nonnegative number of seconds.");
  await prepareOutputFiles([input], [output], "input MP4");
  const ffmpeg = requireFfmpeg();
  const work = await mkdtemp(path.join(path.dirname(path.resolve(output)), ".drawcast-"));
  const source = ["-nostdin", "-hide_banner", "-v", "error", "-xerror", "-f", "mov", "-i", path.resolve(input), "-map", "0:V:0"];
  const options = { windowsHide: true, signal, killSignal: "SIGKILL" as const };
  try {
    const metadata = path.join(work, "packets.txt");
    await exec(ffmpeg, [...source, "-c:v", "copy", "-f", "framecrc", metadata], options);
    const { starts, ticksPerSecond, duration } = await readTimeline(metadata, signal);
    if (at !== undefined && at >= duration) throw new Error(`--at must be less than the video duration (${Number(duration.toFixed(6))} s).`);
    const seconds = (i: number) => (starts[i] - starts[0]) / ticksPerSecond;
    const count = Math.min(6, starts.length);
    const indices = at === undefined
      ? Array.from({ length: count }, (_, i) => Math.round(i * (starts.length - 1) / Math.max(1, count - 1)))
      : [starts.findLastIndex((_, i) => seconds(i) <= at)];

    const selected = indices.map((i) => `eq(n\\,${i})`).join("+");
    const columns = Math.min(indices.length, 3);
    const filter = at === undefined
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
