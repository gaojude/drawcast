/**
 * Online voices: Microsoft's neural voices, the ones behind Read Aloud in the Edge browser.
 *
 * drawcast does not talk to that service itself. Microsoft does not offer it as an API and changes the
 * handshake now and then, and the `edge-tts` program (https://github.com/rany2/edge-tts) keeps up with
 * it. So an `edge:` voice runs that program, which has to be installed separately, and the narration is
 * sent to Microsoft, which never happens with the built-in voice.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFfmpeg } from "../render/encode.ts";
import type { Audio } from "./wav.ts";

/** A script names an online voice as `edge:` and Microsoft's name for it, e.g. `edge:en-US-EmmaMultilingualNeural`. */
export const EDGE_PREFIX = "edge:";

/** A few voices worth trying, for `drawcast voices`. `edge-tts --list-voices` has the rest. */
export const EDGE_VOICES: { name: string; language: "zh" | "en"; description: string }[] = [
  { name: "en-US-EmmaMultilingualNeural", language: "en", description: "American English, female, cheerful" },
  { name: "en-US-AvaMultilingualNeural", language: "en", description: "American English, female, expressive" },
  { name: "en-US-AndrewMultilingualNeural", language: "en", description: "American English, male, warm" },
  { name: "zh-CN-XiaoxiaoNeural", language: "zh", description: "Mandarin, female, warm" },
  { name: "zh-CN-XiaoyiNeural", language: "zh", description: "Mandarin, female, lively" },
  { name: "zh-CN-YunxiNeural", language: "zh", description: "Mandarin, male, lively" },
];

/** The service's sample rate. */
const SAMPLE_RATE = 24000;

/** `edge-tts` from DRAWCAST_EDGE_TTS, the PATH, or ~/.local/bin, where pipx and uv put it. */
export function edgeTtsStatus(): { program: string | null; description: string } {
  const local = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "edge-tts.exe" : "edge-tts");
  const candidates = process.env.DRAWCAST_EDGE_TTS ? [process.env.DRAWCAST_EDGE_TTS] : ["edge-tts", ...(existsSync(local) ? [local] : [])];
  let issue = "edge-tts was not found";
  for (const program of candidates) {
    const result = spawnSync(program, ["--version"], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 5000, windowsHide: true });
    if (result.status === 0) return { program, description: `installed (${program})` };
    const error = result.error as NodeJS.ErrnoException | undefined;
    if (!process.env.DRAWCAST_EDGE_TTS && error?.code === "ENOENT") continue;
    const reason = result.stderr?.trim().split(/\r?\n/)[0]?.slice(0, 300) || error?.code || `exit ${result.status}`;
    issue = `${process.env.DRAWCAST_EDGE_TTS ? "DRAWCAST_EDGE_TTS " : ""}"${program}" failed its version check (${reason})`;
  }
  return { program: null, description: `${issue}. Install it with "pipx install edge-tts" or "uv tool install edge-tts", or set DRAWCAST_EDGE_TTS to a working executable.` };
}

/** Runs a program with `input` on its stdin and returns what it writes to stdout. */
function run(program: string, args: string[], input: string | Buffer, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env }, signal, windowsHide: true });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    // a program that exits early must be reported by its own message, not EPIPE
    child.stdin.on("error", () => {});
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(stderr.trim() || `exit ${code}`))));
    child.stdin.end(input);
  });
}

/** Gets ready to speak with the online voice `name`. Returns the function that says one sentence. */
export async function openEdgeVoice(name: string, signal?: AbortSignal): Promise<(sentence: string) => Promise<Audio>> {
  signal?.throwIfAborted();
  const { program: edgeTts, description } = edgeTtsStatus();
  if (!edgeTts) {
    throw new Error(`The voice "${EDGE_PREFIX}${name}" needs edge-tts. ${description}`);
  }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg was not found. Reinstall drawcast with install scripts allowed, install ffmpeg, or set DRAWCAST_FFMPEG to one.");

  return async (sentence) => {
    // edge-tts reads the text from stdin and writes an MP3 to stdout; PYTHONUTF8 makes it read UTF-8 on Windows too
    const mp3 = await run(edgeTts, ["--voice", name, "--file", "-"], sentence, signal, { PYTHONUTF8: "1" }).catch((e: Error) => {
      signal?.throwIfAborted();
      throw new Error(`edge-tts could not say "${sentence}" in the voice ${name}. It needs a connection, and a name from "edge-tts --list-voices".\n${e.message}`);
    });
    const pcm = await run(ffmpeg, ["-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"], mp3, signal);
    if (pcm.length < 4) throw new Error(`The voice ${name} returned no audio for "${sentence}".`);
    const samples = new Float32Array(pcm.length >> 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readFloatLE(i * 4);
    return { samples, sampleRate: SAMPLE_RATE };
  };
}
