/**
 * Paid voices: MiniMax's speech models (https://platform.minimax.io), by their HTTP API.
 *
 * These cost money by the character, so they are used only when a script or `--voice` names one, and
 * never as a fallback. A sentence that was spoken once is cached like any other, so rendering again,
 * or after changing one sentence, pays only for what is new.
 *
 * The API key is never written in a script, which is shared and often written by an agent. It comes from
 * MINIMAX_API_KEY, or from a file that `drawcast key minimax` saves after reading the key from the
 * terminal. The file serves a program that was already running when the key was set, such as an agent's
 * session, and spares the person from pasting the key into a conversation.
 *
 * A key belongs to one of MiniMax's two platforms, the international one and the one for mainland China,
 * and each has its own address. A key that the first does not accept is tried on the second.
 */
import { readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configDir } from "../paths.ts";
import type { Audio } from "./wav.ts";

/** A script names a MiniMax voice as `minimax:` and its voice id, e.g. `minimax:male-qn-qingse`. */
export const MINIMAX_PREFIX = "minimax:";
/** The model, unless the voice name ends in `@` and another one, e.g. `minimax:hunyin_6@speech-2.8-turbo`. */
export const MINIMAX_MODEL = "speech-2.8-hd";
/** The international platform first, then mainland China's. MINIMAX_API_HOST names one instead. */
export const MINIMAX_HOSTS = ["api.minimax.io", "api.minimaxi.com"];

/** A few of MiniMax's own voices, for `drawcast voices`. Any voice id from MiniMax works, cloned ones too. */
export const MINIMAX_VOICES: { name: string; language: "zh" | "en"; description: string }[] = [
  { name: "male-qn-qingse", language: "zh", description: "Mandarin, male, young" },
  { name: "female-shaonv", language: "zh", description: "Mandarin, female, young" },
];

/** The audio is asked for as raw 16-bit PCM, which needs neither ffmpeg nor a WAV header to read. */
const SAMPLE_RATE = 32000;
/** A long sentence takes a few seconds; one that takes a minute is not coming. */
const TIMEOUT_MS = 60_000;

/**
 * How long to wait before each new try. A rate limit counts requests per minute, and a new account's
 * limit is low enough for one render to reach it, so those waits add up to more than a minute. Tests
 * shorten them.
 */
export const RETRY_WAITS = {
  transient: [1000, 2000, 4000, 8000],
  rateLimit: [5000, 10000, 20000, 30000, 30000],
};

/** status codes: the key is not one this platform knows */
const WRONG_KEY = new Set([1004, 2049]);
/** status codes: requests or tokens per minute */
const RATE_LIMIT = new Set([1002, 1039]);
/** status codes worth asking again for: unknown error, timeout, and the rate limits */
const TRANSIENT = new Set([1000, 1001, ...RATE_LIMIT]);

const keyFile = () => path.join(configDir(), "minimax-api-key");

/** The API key and where it came from, or null. MINIMAX_API_KEY wins over a saved key. */
export function minimaxKey(): { key: string; source: string } | null {
  const env = process.env.MINIMAX_API_KEY?.trim();
  if (env) return { key: env, source: "MINIMAX_API_KEY" };
  try {
    const saved = readFileSync(keyFile(), "utf8").trim();
    if (saved) return { key: saved, source: keyFile() };
  } catch {
    // no saved key
  }
  return null;
}

/** For `drawcast voices` and `setup`. Shows where the key is and how it ends, never the key. */
export function minimaxKeyStatus(): string {
  const found = minimaxKey();
  if (!found) return `no API key. Run "drawcast key minimax" in your own terminal, or set MINIMAX_API_KEY`;
  return `API key ending ${found.key.slice(-4)}, ${found.source === "MINIMAX_API_KEY" ? "from MINIMAX_API_KEY" : `saved in ${found.source}`}`;
}

/** Saves a key for later runs, readable only by this user where the system allows. Returns the file. */
export async function saveMinimaxKey(key: string): Promise<string> {
  const file = keyFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  // a file that was already there keeps its old mode through writeFile
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeMinimaxKey(): Promise<string> {
  await rm(keyFile(), { force: true });
  return keyFile();
}

/** `minimax:<voice id>[@<model>]` without the prefix. */
export function parseMinimaxVoice(spec: string): { voiceId: string; model: string } {
  const [voiceId, model, ...rest] = spec.split("@").map((s) => s.trim());
  if (!voiceId || rest.length || model === "") {
    throw new Error(`"${MINIMAX_PREFIX}${spec}" is not a MiniMax voice. Write "${MINIMAX_PREFIX}<voice id>", such as "${MINIMAX_PREFIX}${MINIMAX_VOICES[0].name}", and add "@<model>" for a model other than ${MINIMAX_MODEL}.`);
  }
  return { voiceId, model: model ?? MINIMAX_MODEL };
}

class MinimaxError extends Error {
  readonly code: number | undefined;
  readonly transient: boolean;
  readonly rateLimited: boolean;
  constructor(message: string, code: number | undefined, transient: boolean, rateLimited = false) {
    super(message);
    this.code = code;
    this.transient = transient;
    this.rateLimited = rateLimited;
  }
}

interface Reply {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: { audio?: string } | null;
}

/** One request. Returns the PCM. */
async function post(host: string, key: string, body: string, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://${host}/v1/t2a_v2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    signal?.throwIfAborted();
    throw new MinimaxError(`could not reach ${host}: ${e instanceof Error ? e.message : e}`, undefined, true);
  }
  const transientHttp = response.status === 429 || response.status >= 500;
  let reply: Reply;
  try {
    reply = JSON.parse(await response.text());
  } catch {
    signal?.throwIfAborted();
    throw new MinimaxError(`${host} answered HTTP ${response.status} without the expected JSON`, undefined, transientHttp, response.status === 429);
  }
  const code = reply.base_resp?.status_code;
  if (code === 0 && reply.data?.audio) return Buffer.from(reply.data.audio, "hex");
  const message = `${reply.base_resp?.status_msg || `HTTP ${response.status}`} (status ${code ?? "missing"})`;
  const rateLimited = response.status === 429 || (code !== undefined && RATE_LIMIT.has(code));
  throw new MinimaxError(message, code, rateLimited || transientHttp || (code !== undefined && TRANSIENT.has(code)), rateLimited);
}

/** Asks again, after a growing wait, while the trouble looks passing: a rate limit, a timeout, a dropped connection. */
async function postWithRetries(host: string, key: string, body: string, signal?: AbortSignal, onWait?: (e: MinimaxError) => void): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await post(host, key, body, signal);
    } catch (e) {
      if (!(e instanceof MinimaxError) || !e.transient) throw e;
      const waits = e.rateLimited ? RETRY_WAITS.rateLimit : RETRY_WAITS.transient;
      if (attempt >= waits.length) throw e;
      onWait?.(e);
      // a little jitter, so that sentences that were refused together are not asked for together again
      await delay(waits[attempt] * (1 + Math.random() * 0.25), undefined, { signal });
    }
  }
}

function decode(pcm: Buffer): Audio {
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: SAMPLE_RATE };
}

/** What went wrong, said so that the person knows what to do about it. */
function explain(e: unknown, o: { voiceId: string; model: string; source: string; hosts: string[]; sentence: string }): Error {
  if (!(e instanceof MinimaxError)) return e instanceof Error ? e : new Error(String(e));
  const name = `${MINIMAX_PREFIX}${o.voiceId}`;
  if (e.code !== undefined && WRONG_KEY.has(e.code)) {
    return new Error(`MiniMax did not accept the API key (${o.source}) at ${o.hosts.join(" or ")}: ${e.message}. Check the key, or set MINIMAX_API_HOST to your platform's address.`);
  }
  if (e.code === 1008) return new Error(`The MiniMax account has run out of balance: ${e.message}. Top it up and render again; sentences already spoken are cached and are not paid for twice.`);
  if (e.code === 2054) return new Error(`MiniMax has no voice "${o.voiceId}" for this account: ${e.message}. Use a voice id from MiniMax's voice list, or one you cloned.`);
  if (e.code === 2013) return new Error(`MiniMax refused the request for ${name} with the model ${o.model}: ${e.message}. Check the voice id and the model name.`);
  return new Error(`MiniMax could not say "${o.sentence}" in the voice ${name}: ${e.message}`);
}

/** Gets ready to speak with a MiniMax voice. Returns the function that says one sentence. */
export async function openMinimaxVoice(spec: { voiceId: string; model: string }, log: (line: string) => void, signal?: AbortSignal): Promise<(sentence: string) => Promise<Audio>> {
  signal?.throwIfAborted();
  const found = minimaxKey();
  if (!found) {
    throw new Error(`The voice "${MINIMAX_PREFIX}${spec.voiceId}" is MiniMax's, which is paid and needs an API key. Have its owner run "drawcast key minimax" in their own terminal and paste it there, or set MINIMAX_API_KEY. Never put the key in the script.`);
  }
  const configured = process.env.MINIMAX_API_HOST?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const hosts = configured ? [configured] : MINIMAX_HOSTS;

  /** The address that takes the key, found by the first sentence; the others wait for it. */
  let ready: Promise<string> | undefined;
  // said once, so that a render that slows down to the account's rate limit does not look stuck
  let toldOfLimit = false;
  const onWait = (e: MinimaxError) => {
    if (!e.rateLimited || toldOfLimit) return;
    toldOfLimit = true;
    log(`  MiniMax's rate limit for this account was reached (${e.message}); waiting, then asking again`);
  };

  return async (sentence) => {
    signal?.throwIfAborted();
    const body = JSON.stringify({
      model: spec.model,
      text: sentence,
      stream: false,
      // drawcast changes the speed itself, after the sentence is spoken, so that one recording serves every speed
      voice_setting: { voice_id: spec.voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: SAMPLE_RATE, format: "pcm", channel: 1 },
      language_boost: "auto",
      output_format: "hex",
    });
    const context = { ...spec, source: found.source, hosts, sentence };
    try {
      if (ready) return decode(await postWithRetries(await ready, found.key, body, signal, onWait));
      let pcm: Buffer | undefined;
      ready = (async () => {
        for (const [i, host] of hosts.entries()) {
          try {
            pcm = await postWithRetries(host, found.key, body, signal, onWait);
            log(`  MiniMax ${spec.model} at ${host}, key ${found.source === "MINIMAX_API_KEY" ? "from MINIMAX_API_KEY" : "saved by drawcast key"}`);
            return host;
          } catch (e) {
            // a key for the other platform: try there
            if (e instanceof MinimaxError && e.code !== undefined && WRONG_KEY.has(e.code) && i < hosts.length - 1) continue;
            throw e;
          }
        }
        throw new Error("unreachable");
      })();
      await ready;
      return decode(pcm!);
    } catch (e) {
      signal?.throwIfAborted();
      throw explain(e, context);
    }
  };
}
