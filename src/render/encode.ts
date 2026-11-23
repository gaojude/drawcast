/** Frames + narration -> MP4 (H.264 + AAC), by way of ffmpeg. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { once } from "node:events";

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

export interface Encoder {
  /** Appends one frame (a PNG). */
  write(png: Buffer): Promise<void>;
  finish(): Promise<void>;
}

export function startEncoder(o: { output: string; fps: number; audio: string }): Encoder {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg was not found. Reinstall drawcast with install scripts allowed, install ffmpeg, or set DRAWCAST_FFMPEG to one.");
  const child = spawn(
    ffmpeg,
    [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "png", "-i", "-",
      "-i", o.audio,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "animation",
      // yuv420p and even dimensions are what players everywhere expect
      "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      o.output,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}).\n${stderr.trim()}`))));
  });
  // a write to a dead ffmpeg must surface ffmpeg's error, not EPIPE
  child.stdin.on("error", () => {});

  return {
    async write(png) {
      if (!child.stdin.write(png)) await Promise.race([once(child.stdin, "drain"), exited]);
    },
    async finish() {
      child.stdin.end();
      await exited;
    },
  };
}
