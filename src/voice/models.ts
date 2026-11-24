/** Downloading the speech model on first use. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
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

function modelFiles(): ModelFiles {
  const dir = path.join(modelsDir(), KOKORO);
  return {
    model: path.join(dir, "model.onnx"),
    voices: path.join(dir, "voices.bin"),
    tokens: path.join(dir, "tokens.txt"),
    english: path.join(dir, "lexicon-us-en.txt"),
    chinese: path.join(dir, "lexicon-zh.txt"),
  };
}

export const modelsInstalled = () => Object.values(modelFiles()).every((f) => existsSync(f));

async function download(url: string, to: string, sha256: string, log: (line: string) => void): Promise<void> {
  const res = await fetch(url);
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
  // write beside the target and rename, so an interrupted download is never mistaken for a model
  await pipeline(body, createWriteStream(`${to}.part`));
  if (hash.digest("hex") !== sha256) {
    await rm(`${to}.part`);
    throw new Error(`${url} is not the file drawcast expects (its checksum differs). Try again; if it keeps happening, the published model has changed and drawcast needs an update.`);
  }
  await rename(`${to}.part`, to);
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xjf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (d) => (stderr += d));
    tar.on("error", () => reject(new Error("Unpacking the speech model needs the `tar` command (with bzip2 support), which was not found.")));
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr.trim()}`))));
  });
}

/** The model's files, downloaded (about 365 MB) the first time they are needed. */
export async function ensureModels(log: (line: string) => void): Promise<ModelFiles> {
  const files = modelFiles();
  if (modelsInstalled()) return files;
  await mkdir(modelsDir(), { recursive: true });
  log(`Downloading the speech model to ${modelsDir()} (once, about 365 MB)`);
  const archive = path.join(modelsDir(), `${KOKORO}.tar.bz2`);
  await download(`${RELEASES}/tts-models/${KOKORO}.tar.bz2`, archive, SHA256, log);
  await untar(archive, modelsDir());
  await rm(archive);
  if (!modelsInstalled()) throw new Error(`The speech model in ${modelsDir()} is incomplete. Delete that folder and try again.`);
  return files;
}
