/** Downloading the speech model on first use. */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cacheDir } from "../paths.ts";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const ZIPVOICE = "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia";

export interface ModelFiles {
  tokens: string;
  encoder: string;
  decoder: string;
  vocoder: string;
  /** the Chinese pronunciation dictionary that comes with the model */
  lexicon: string;
}

export const modelsDir = () => path.join(cacheDir(), "models");

function modelFiles(): ModelFiles {
  const dir = path.join(modelsDir(), ZIPVOICE);
  return {
    tokens: path.join(dir, "tokens.txt"),
    encoder: path.join(dir, "encoder.int8.onnx"),
    decoder: path.join(dir, "decoder.int8.onnx"),
    lexicon: path.join(dir, "lexicon.txt"),
    vocoder: path.join(modelsDir(), "vocos_24khz.onnx"),
  };
}

export const modelsInstalled = () => Object.values(modelFiles()).every((f) => existsSync(f));

async function download(url: string, to: string, log: (line: string) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  let done = 0;
  let shown = -1;
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    const tenth = total ? Math.floor((done / total) * 10) : -1;
    if (tenth > shown) {
      shown = tenth;
      log(`  ${path.basename(to)}: ${tenth * 10}% of ${(total / 1e6).toFixed(0)} MB`);
    }
  });
  // write beside the target and rename, so an interrupted download is never mistaken for a model
  await pipeline(body, createWriteStream(`${to}.part`));
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

/** The model's files, downloaded (about 180 MB) the first time they are needed. */
export async function ensureModels(log: (line: string) => void): Promise<ModelFiles> {
  const files = modelFiles();
  if (modelsInstalled()) return files;
  await mkdir(modelsDir(), { recursive: true });
  log(`Downloading the speech model to ${modelsDir()} (once, about 180 MB)`);
  if (!existsSync(files.vocoder)) await download(`${RELEASES}/vocoder-models/vocos_24khz.onnx`, files.vocoder, log);
  if (!existsSync(files.decoder)) {
    const archive = path.join(modelsDir(), `${ZIPVOICE}.tar.bz2`);
    await download(`${RELEASES}/tts-models/${ZIPVOICE}.tar.bz2`, archive, log);
    await untar(archive, modelsDir());
    await rm(archive);
  }
  if (!modelsInstalled()) throw new Error(`The speech model in ${modelsDir()} is incomplete. Delete that folder and try again.`);
  return files;
}
