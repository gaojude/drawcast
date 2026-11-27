/** Downloading the speech model on first use. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cacheDir } from "../paths.ts";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
/** Kokoro v1.1, the one that speaks Chinese as well as English, as packaged for sherpa-onnx. */
const KOKORO = "kokoro-multi-lang-v1_1";
/** SHA-256 of the download, so that what runs is what was tested. */
const SHA256 = "b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed";

export interface ModelFiles {
  model: string;
  /** the speakers */
  voices: string;
  tokens: string;
  /** the pronunciation dictionaries that come with the model */
  english: string;
  chinese: string;
}

export const modelsDir = () => path.join(cacheDir(), "models");

function modelFiles(root: string): ModelFiles {
  const dir = path.join(root, KOKORO);
  return {
    model: path.join(dir, "model.onnx"),
    voices: path.join(dir, "voices.bin"),
    tokens: path.join(dir, "tokens.txt"),
    english: path.join(dir, "lexicon-us-en.txt"),
    chinese: path.join(dir, "lexicon-zh.txt"),
  };
}

/** Sizes of the required files in the pinned archive. An interrupted older installation may contain every filename. */
const requiredSizes = { model: 325561476, voices: 53790720, tokens: 1111, english: 5956885, chinese: 2120131 };
const required = Object.keys(requiredSizes) as (keyof ModelFiles)[];
const complete = (files: ModelFiles) => required.every((key) => statSync(files[key], { throwIfNoEntry: false })?.size === requiredSizes[key]);
export const modelsInstalled = () => complete(modelFiles(modelsDir()));

async function download(url: string, to: string, sha256: string, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  let done = 0;
  let shown = -1;
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    done += chunk.length;
    const tenth = total ? Math.floor((done / total) * 10) : -1;
    if (tenth > shown) {
      shown = tenth;
      log(`  ${path.basename(to)}: ${tenth * 10}% of ${(total / 1e6).toFixed(0)} MB`);
    }
  });
  await pipeline(body, createWriteStream(to), { signal });
  if (hash.digest("hex") !== sha256) {
    throw new Error(`${url} is not the file drawcast expects (its checksum differs). Try again; if it keeps happening, the published model has changed and drawcast needs an update.`);
  }
}

function untar(archive: string, into: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xjf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"], signal, windowsHide: true });
    let stderr = "";
    tar.stderr.on("data", (d) => (stderr += d));
    // On abort wait for close so the staging directory is no longer in use on Windows.
    tar.on("error", (error) => { if (!signal.aborted) reject(new Error(`Could not run tar to unpack the speech model: ${error.message}`)); });
    tar.on("close", (code) => (signal.aborted ? reject(signal.reason) : code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr.trim()}`))));
  });
}

/** The model's files, downloaded (about 365 MB) the first time they are needed. */
async function install(root: string, log: (line: string) => void, signal: AbortSignal): Promise<ModelFiles> {
  const files = modelFiles(root);
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(path.join(root, ".download-"));
  try {
    log(`Downloading the speech model to ${root} (once, about 365 MB)`);
    const archive = path.join(stage, `${KOKORO}.tar.bz2`);
    await download(`${RELEASES}/tts-models/${KOKORO}.tar.bz2`, archive, SHA256, log, signal);
    await untar(archive, stage, signal);
    signal.throwIfAborted();
    const unpacked = modelFiles(stage);
    if (!complete(unpacked)) throw new Error("The downloaded archive contains an incomplete speech model.");
    if (!complete(files)) {
      try {
        await rename(path.join(stage, KOKORO), path.join(root, KOKORO));
      } catch (error) {
        // A previous installation may be incomplete, or another process may have just finished one.
        if (!statSync(path.join(root, KOKORO), { throwIfNoEntry: false })?.isDirectory()) throw error;
        for (const key of required) {
          if (statSync(files[key], { throwIfNoEntry: false })?.size !== requiredSizes[key]) await rename(unpacked[key], files[key]);
        }
      }
    }
    return files;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

interface Installation {
  result: Promise<ModelFiles>;
  controller: AbortController;
  callers: number;
}

const installing = new Map<string, Installation>();

export async function ensureModels(log: (line: string) => void, signal?: AbortSignal): Promise<ModelFiles> {
  signal?.throwIfAborted();
  const root = modelsDir();
  const files = modelFiles(root);
  if (complete(files)) return files;
  let pending = installing.get(root);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    const result = install(root, log, controller.signal).finally(() => {
      if (installing.get(root)?.controller === controller) installing.delete(root);
    });
    pending = { controller, result, callers: 0 };
    installing.set(root, pending);
  }
  pending.callers++;
  let cancel: (() => void) | undefined;
  try {
    if (!signal) return await pending.result;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([pending.result, cancelled]);
  } finally {
    if (cancel) signal!.removeEventListener("abort", cancel);
    if (--pending.callers === 0 && signal?.aborted) {
      pending.controller.abort(signal.reason);
      await pending.result.catch(() => {});
    }
  }
}
