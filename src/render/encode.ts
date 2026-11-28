/** Video + narration -> MP4 (H.264 + AAC), by way of ffmpeg. */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { type ColorSpace, colorTags } from "../shared/h264.ts";

/** The ffmpeg that comes with the `ffmpeg-static` package, else one on the PATH. */
export function findFfmpeg(): string | null {
  const works = (file: string) => spawnSync(file, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 5000 }).status === 0;
  const chosen = process.env.DRAWCAST_FFMPEG;
  if (chosen) {
    if (!works(chosen)) {
      throw new Error(`DRAWCAST_FFMPEG points at ${chosen}, which could not run ffmpeg -version.`);
    }
    return chosen;
  }
  try {
    const bundled: string | null = createRequire(import.meta.url)("ffmpeg-static");
    if (bundled && works(bundled)) return bundled;
  } catch {
    // not installed; fall through to the PATH
  }
  return works("ffmpeg") ? "ffmpeg" : null;
}

export function requireFfmpeg(): string {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg was not found. Reinstall drawcast with install scripts allowed, install ffmpeg, or set DRAWCAST_FFMPEG to one.");
  return ffmpeg;
}

/** An ffmpeg that is making the file from what it is sent. */
export interface Encoder {
  /** Appends video: a frame as a PNG, or a stretch of H.264, whichever this one takes. */
  write(data: Buffer): Promise<void>;
  finish(): Promise<void>;
  /** Stops without finishing the file. */
  abort(): Promise<void>;
}

export interface Output {
  output: string;
  fps: number;
  ffmpeg?: string;
  signal?: AbortSignal;
}

/** What ends every command line: the narration as AAC, and a file that plays before it has all arrived. */
const TAIL = ["-map", "0:v:0", "-map", "1:a:0", "-abort_on", "empty_output_stream", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"];

function run(args: string[], ffmpeg = requireFfmpeg(), signal?: AbortSignal): Encoder {
  signal?.throwIfAborted();
  const child = spawn(ffmpeg, ["-y", "-loglevel", "error", ...args], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const video = child.stdin!;
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const stop = () => { child.kill("SIGKILL"); };
  signal?.addEventListener("abort", stop, { once: true });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (signal?.aborted ? reject(signal.reason) : code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}).\n${stderr.trim()}`))));
  }).finally(() => signal?.removeEventListener("abort", stop));
  // An ffmpeg that has given up says so at the next write, not only at the end: a pipe takes small writes
  // whether or not anyone is reading. (This also keeps an abandoned ffmpeg's exit from going unhandled.)
  let failure: Error | null = null;
  exited.catch((e) => (failure = e));
  // a write to a dead ffmpeg must surface ffmpeg's error, not EPIPE
  video.on("error", () => {});

  return {
    async write(data) {
      if (failure) throw failure;
      await new Promise<void>((resolve, reject) => video.write(data, (error) => error ? reject(error) : resolve()));
    },
    async finish() {
      video.end();
      await exited;
    },
    async abort() {
      video.destroy();
      child.kill();
      await exited.catch(() => {});
    },
  };
}

/** Mux the browser's H.264 frames with the completed PCM narration. */
export function startMuxer(o: Output & { color: ColorSpace | null; audio: string; pcmRate: number }): Encoder {
  const tags = colorTags(o.color);
  // Even an in-order stream can advertise a decoding delay. Starting DTS below zero
  // makes MP4 players skip the cover and opening frames. The page verifies frame order.
  // Older and newer FFmpeg muxers can supply different input time bases to the filter.
  // Set packet timestamps, durations and the MP4 track to the same 90 kHz clock.
  const clock = 90000;
  const timestamp = `round(N*${clock}/${o.fps})`;
  const duration = `round((N+1)*${clock}/${o.fps})-${timestamp}`;
  const filters = [`setts=time_base=1/${clock}:ts=${timestamp}:duration=${duration}`];
  if (tags) filters.push(`h264_metadata=${tags}`);
  return run(
    [
      // The stream carries no times. `-r` gives every frame one; `-framerate` would time only the frames
      // ffmpeg reads while working out what the stream is, and leave the rest a tick apart.
      "-f", "h264", "-r", String(o.fps), "-i", "pipe:0",
      "-f", "s16le", "-ar", String(o.pcmRate), "-ac", "1", "-i", o.audio,
      "-c:v", "copy", "-bsf:v", filters.join(","), "-video_track_timescale", String(clock),
      ...TAIL, o.output,
    ],
    o.ffmpeg,
    o.signal,
  );
}

/**
 * Makes the file from frames sent as PNGs, which ffmpeg encodes itself, and the narration in the PCM
 * file `audio`. Works with any browser, slowly.
 */
export function startEncoder(o: Output & { audio: string; pcmRate: number }): Encoder {
  return run(
    [
      "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "png", "-i", "pipe:0",
      "-f", "s16le", "-ar", String(o.pcmRate), "-ac", "1", "-i", o.audio,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "animation",
      // yuv420p is what players everywhere expect. The colours are stored the way HD video stores them
      // (BT.709) and labelled so; ffmpeg's own choice is the SD way, unlabelled, which players then misread.
      "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-color_range", "tv",
      ...TAIL, o.output,
    ],
    o.ffmpeg,
    o.signal,
  );
}
