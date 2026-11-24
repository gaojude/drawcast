/** Video + narration -> MP4 (H.264 + AAC), by way of ffmpeg. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { type ColorSpace, colorTags } from "../shared/h264.ts";

/** The ffmpeg that comes with the `ffmpeg-static` package, else one on the PATH. */
export function findFfmpeg(): string | null {
  if (process.env.DRAWCAST_FFMPEG) return process.env.DRAWCAST_FFMPEG;
  try {
    const bundled: string | null = createRequire(import.meta.url)("ffmpeg-static");
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // not installed; fall through to the PATH
  }
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 ? "ffmpeg" : null;
}

/** An ffmpeg that is making the file from what it is sent. */
export interface Encoder {
  /** Appends video: a frame as a PNG, or a stretch of H.264, whichever this one takes. */
  write(data: Buffer): Promise<void>;
  finish(): Promise<void>;
  /** Stops without finishing the file. */
  abort(): Promise<void>;
}

/** An encoder that is sent the narration too, a piece at a time, instead of finding it whole in a file. */
export interface Muxer extends Encoder {
  /** Appends narration: one channel of 16-bit samples, low byte first. */
  sound(pcm: Buffer): void;
}

export interface Output {
  output: string;
  fps: number;
}

/** What ends every command line: the narration as AAC, and a file that plays before it has all arrived. */
const TAIL = ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"];

/**
 * Runs ffmpeg with the video on its stdin and, when `soundPipe` is set, a second pipe to it for the
 * narration (its file descriptor 3). `patient` writes wait for ffmpeg to take what it was sent, which
 * matters when that is a great deal, as PNGs are.
 */
function run(args: string[], o: { soundPipe: boolean; patient: boolean }): Muxer {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg was not found. Reinstall drawcast with install scripts allowed, install ffmpeg, or set DRAWCAST_FFMPEG to one.");
  const child = spawn(ffmpeg, ["-y", "-loglevel", "error", ...args], { stdio: ["pipe", "ignore", "pipe", ...(o.soundPipe ? ["pipe" as const] : [])] });
  const video = child.stdin!;
  const sound = (child.stdio[3] ?? null) as Writable | null;
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}).\n${stderr.trim()}`))));
  });
  // An ffmpeg that has given up says so at the next write, not only at the end: a pipe takes small writes
  // whether or not anyone is reading. (This also keeps an abandoned ffmpeg's exit from going unhandled.)
  let failure: Error | null = null;
  exited.catch((e) => (failure = e));
  // a write to a dead ffmpeg must surface ffmpeg's error, not EPIPE
  video.on("error", () => {});
  sound?.on("error", () => {});

  return {
    async write(data) {
      if (failure) throw failure;
      if (!video.write(data) && o.patient) await Promise.race([once(video, "drain"), exited]);
    },
    sound(pcm) {
      if (failure) throw failure;
      sound?.write(pcm);
    },
    async finish() {
      video.end();
      sound?.end();
      await exited;
    },
    async abort() {
      video.destroy();
      sound?.destroy();
      child.kill();
      await exited.catch(() => {});
    },
  };
}

/**
 * Makes the file from H.264 that is already encoded and narration that arrives as it is spoken. The
 * video is copied into the file untouched; only the narration is encoded. `color` is how the video
 * encoder stored colour, which the stream is labelled with.
 *
 * Neither kind of write waits: ffmpeg takes video and sound in step, so while the speech is behind it
 * leaves video unread, and the drawing must not stop for that. All of a video's H.264 is a few megabytes.
 */
export function startMuxer(o: Output & { color: ColorSpace | null; sampleRate: number }): Muxer {
  const tags = colorTags(o.color);
  return run(
    [
      // The stream carries no times. `-r` gives every frame one; `-framerate` would time only the frames
      // ffmpeg reads while working out what the stream is, and leave the rest a tick apart.
      "-f", "h264", "-r", String(o.fps), "-i", "pipe:0",
      "-f", "s16le", "-ar", String(o.sampleRate), "-ac", "1", "-i", "pipe:3",
      "-c:v", "copy", ...(tags ? ["-bsf:v", `h264_metadata=${tags}`] : []),
      ...TAIL, o.output,
    ],
    { soundPipe: true, patient: false },
  );
}

/**
 * Makes the file from frames sent as PNGs, which ffmpeg encodes itself, and the narration in the WAV
 * file `audio`. Works with any browser, slowly.
 */
export function startEncoder(o: Output & { audio: string }): Encoder {
  return run(
    [
      "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "png", "-i", "pipe:0",
      "-i", o.audio,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "animation",
      // yuv420p is what players everywhere expect. The colours are stored the way HD video stores them
      // (BT.709) and labelled so; ffmpeg's own choice is the SD way, unlabelled, which players then misread.
      "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-color_range", "tv",
      ...TAIL, o.output,
    ],
    { soundPipe: false, patient: true },
  );
}
