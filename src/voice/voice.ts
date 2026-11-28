/**
 * The voices. A voice says one sentence at a time and returns the audio.
 *
 * The default engine is Kokoro, which runs on the CPU with sherpa-onnx. It is a small
 * model with a fixed set of speakers for Chinese and English. A script can also name one of MiniMax's
 * paid voices (`minimax:...`). `--tts-command` swaps the engine for any program that turns text into a
 * WAV file.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { cacheDir } from "../paths.ts";
import { isCjk } from "../shared/text.ts";
import { writeFileAtomic } from "../shared/files.ts";
import { MINIMAX_PREFIX, minimaxKey, openMinimaxVoice, parseMinimaxVoice } from "./minimax.ts";
import { type ModelFiles, ensureModels } from "./models.ts";
import { normalize } from "./normalize.ts";
import { type Dictionaries, parseDictionary, toTokens } from "./tokenize.ts";
import { type Audio, readWav } from "./wav.ts";

export interface Voice {
  /** What the voice is called, as a script names it: for the log. */
  name: string;
  /** Identifies the voice and its settings; audio is cached under it. */
  key: string;
  /**
   * Gets ready to speak (loads the model). Returns the function that says one sentence. `speed` is
   * given only to a voice with `nativeSpeed`.
   */
  open(signal?: AbortSignal, speed?: number): Promise<(sentence: string) => Promise<Audio>>;
  /** How many sentences it can be asked for at once. Left out, one. */
  parallel?: number;
  /**
   * The voice speaks at the script's speed itself, which sounds more natural than speech made faster
   * afterwards. Its speech is then kept for each speed apart, and not stretched. Left out, every speed
   * is made from one recording at normal speed.
   */
  nativeSpeed?: boolean;
  /** The voice that says the whole script instead if this one cannot. */
  fallback?: Voice;
}

interface BuiltIn {
  /** the model's name for the speaker */
  speaker: string;
  /** another speaker mixed into this one, and how much of it */
  mix?: [speaker: string, share: number];
  language: "zh" | "en";
  description: string;
}

/**
 * The voices `drawcast voices` lists, made from the model's speakers.
 *
 * The model's Chinese speakers say English words poorly: in our tests a speech recogniser made out
 * about half of those inside a Chinese sentence. With a third of an English speaker mixed in it made out
 * about three in four, and the Chinese stayed as clear.
 */
const BUILT_IN: Record<string, BuiltIn> = {
  lin: { speaker: "zf_071", mix: ["af_maple", 0.35], language: "zh", description: "Mandarin, female" },
  chen: { speaker: "zm_061", mix: ["af_sol", 0.35], language: "zh", description: "Mandarin, male" },
  maple: { speaker: "af_maple", language: "en", description: "American English, female" },
  sol: { speaker: "af_sol", language: "en", description: "American English, female, lower" },
};

export const builtInVoices = (): Record<string, BuiltIn> => BUILT_IN;

const numbered = (prefix: string, ids: number[]) => ids.map((n) => `${prefix}_${String(n).padStart(3, "0")}`);
/** All of the model's speakers, in the order it numbers them. A script can name any of them. */
export const SPEAKERS = [
  "af_maple", "af_sol", "bf_vale",
  ...numbered("zf", [1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 32, 36, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49, 51, 59, 60, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 83, 84, 85, 86, 87, 88, 90, 92, 93, 94, 99]),
  ...numbered("zm", [9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 29, 30, 31, 33, 34, 35, 37, 41, 45, 50, 52, 53, 54, 55, 56, 57, 58, 61, 62, 63, 64, 65, 66, 68, 69, 80, 81, 82, 89, 91, 95, 96, 97, 98, 100]),
];

const sha = (...parts: string[]) => parts.reduce((h, p) => h.update(p).update("\0"), createHash("sha256")).digest("hex").slice(0, 20);

/** The model's own speed is quick for narration, in English most of all. */
const PACE = { zh: 1, en: 0.9 };
/** Changed whenever the text is turned into tokens differently, so that cached speech is made again. */
const TOKENS = "tokens-2";
/** The model takes about 510 tokens at a time. A sentence is far shorter unless it has no commas at all. */
const MAX_TOKENS = 480;

/** Direct-token input bypasses the engine's text splitter, and oversized input exits the process. */
export function tokenBatches(tokens: string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < tokens.length; ) {
    let end = Math.min(start + MAX_TOKENS, tokens.length);
    if (end < tokens.length) {
      // Spaces separate English words, and a tone number ends each Chinese syllable.
      let boundary = end;
      while (boundary > start && !/^[ ,.;?!1-5]$/.test(tokens[boundary - 1])) boundary--;
      if (boundary > start) end = boundary;
    }
    const batch = tokens.slice(start, end);
    if (batch.some((token) => /[^,.;?! ]/.test(token))) batches.push(batch);
    start = end;
  }
  return batches;
}

async function dictionaries(model: ModelFiles): Promise<Dictionaries> {
  const english = parseDictionary(await readFile(model.english, "utf8"));
  // Letter names get entries of their own (ltra .. ltrz) for spelling out acronyms, which frees "a" to be
  // the article. The dictionary gives both articles their stressed forms.
  for (const letter of "abcdefghijklmnopqrstuvwxyz") english.set(`ltr${letter}`, english.get(letter) ?? []);
  english.set("a", ["ɐ"]);
  english.set("the", ["ð", "ə"]);
  return { english, chinese: parseDictionary(await readFile(model.chinese, "utf8")) };
}

/** An inferred pronunciation belongs to this sentence, so other cached sentences cannot affect it. */
export function speechTokens(text: string, dict: Dictionaries): string[] {
  const normalized = normalize(text, { get: (word) => dict.english.get(word)?.join(" ") });
  return toTokens(normalized.text, {
    chinese: dict.chinese,
    english: { get: (word) => normalized.entries.get(word)?.split(" ") ?? dict.english.get(word) },
  });
}

/**
 * Writes a copy of the model's speakers to `target` in which some are mixed with another one.
 *
 * To the model a speaker is a table of numbers, and a mix of two tables sounds like something between
 * the two speakers. `mixes` maps a speaker to the one mixed into it and that one's share.
 */
export async function mixSpeakers(source: string, target: string, speakers: string[], mixes: Record<string, [speaker: string, share: number]>): Promise<void> {
  const file = await readFile(source);
  const floats = new Float32Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const size = floats.length / speakers.length;
  if (!Number.isInteger(size)) throw new Error(`${source} does not hold ${speakers.length} speakers.`);
  const of = (speaker: string) => floats.subarray(speakers.indexOf(speaker) * size, (speakers.indexOf(speaker) + 1) * size);
  // every mix is made from the speakers as the model has them, whatever order they are written in
  const mixed = Object.entries(mixes).map(([speaker, [other, share]]) => {
    const added = of(other);
    return [speaker, of(speaker).map((v, i) => v * (1 - share) + added[i] * share)] as const;
  });
  for (const [speaker, table] of mixed) of(speaker).set(table);
  await writeFileAtomic(target, Buffer.from(floats.buffer));
}

const MIXES: Record<string, [speaker: string, share: number]> = Object.fromEntries(Object.values(BUILT_IN).flatMap((v) => (v.mix ? [[v.speaker, v.mix]] : [])));

/** The speakers file with the built-in mixes in it, made the first time it is needed. */
async function mixedSpeakers(model: ModelFiles): Promise<string> {
  const target = path.join(path.dirname(model.voices), `voices-${sha(JSON.stringify(MIXES))}.bin`);
  if (statSync(target, { throwIfNoEntry: false })?.size !== statSync(model.voices).size) await mixSpeakers(model.voices, target, SPEAKERS, MIXES);
  return target;
}

function kokoro(name: string, speaker: string, mix: BuiltIn["mix"], log: (line: string) => void): Voice {
  return {
    name,
    key: sha("kokoro-v1.1", TOKENS, speaker, mix?.join(" ") ?? "", String(PACE.zh), String(PACE.en)),
    // One sentence does not keep the machine busy, so with cores to spare several are spoken at once,
    // by the one model. On a 22-thread laptop that halves the time (28 s to 13 s for 74 s of speech).
    // Past four there is nothing more to gain, and each sentence in flight has its own working memory.
    parallel: Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4))),
    async open(signal) {
      const model = await ensureModels(log, signal);
      const dict = await dictionaries(model);
      signal?.throwIfAborted();

      const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
      const tts = new sherpa.OfflineTts({
        model: {
          kokoro: { model: model.model, voices: mix ? await mixedSpeakers(model) : model.voices, tokens: model.tokens },
          // more than eight makes it slower, not faster: 16 took twice as long as 8 on a 22-thread laptop
          numThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
          provider: "cpu",
        },
      });
      if (tts.numSpeakers !== SPEAKERS.length) throw new Error(`The speech model in ${path.dirname(model.model)} is not the one drawcast expects. Delete that folder and try again.`);
      const sid = SPEAKERS.indexOf(speaker);

      return async (sentence) => {
        const batches = tokenBatches(speechTokens(sentence, dict));
        if (!batches.length) throw new Error(`There is nothing the voice can say in: "${sentence}"`);
        const speed = PACE[isCjk(sentence) ? "zh" : "en"];
        const parts: Float32Array[] = [];
        for (const tokens of batches) {
          signal?.throwIfAborted();
          const out = await tts.generateAsync({
            text: "",
            sid,
            speed,
            enableExternalBuffer: false,
            ...(signal && { onProgress: () => signal.aborted ? 0 : 1 }),
            generationConfig: new sherpa.GenerationConfig({
              sid, speed, tokens: [tokens],
              silenceScale: 1,
              extra: { min_words_in_sentence: MAX_TOKENS },
            }),
          });
          signal?.throwIfAborted();
          if (!out.samples?.length) throw new Error(`The voice could not say: "${sentence}"`);
          parts.push(out.samples);
        }
        const samples = new Float32Array(parts.reduce((count, part) => count + part.length, 0));
        let at = 0;
        for (const part of parts) {
          samples.set(part, at);
          at += part.length;
        }
        return { samples, sampleRate: tts.sampleRate };
      };
    },
  };
}

/** A voice that runs a program: the text arrives on stdin, and the program writes a WAV to $DRAWCAST_OUT. */
function commandVoice(command: string): Voice {
  return {
    name: "--tts-command",
    key: sha("command", process.cwd(), command),
    async open(signal) {
      const dir = path.join(cacheDir(), "tmp");
      await mkdir(dir, { recursive: true });
      return async (sentence) => {
        signal?.throwIfAborted();
        const out = path.join(dir, `say-${randomUUID()}.wav`);
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(command, { shell: true, detached: !!signal && process.platform !== "win32", windowsHide: true, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, DRAWCAST_OUT: out, DRAWCAST_TEXT: sentence } });
            let stderr = "";
            // The command runs under a shell. Terminate its descendants before removing their WAV.
            const stop = () => {
              if (!child.pid || child.exitCode !== null) return;
              if (process.platform === "win32") {
                const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
                killer.on("error", () => child.kill());
              } else {
                try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
              }
            };
            signal?.addEventListener("abort", stop, { once: true });
            child.stderr.on("data", (d) => (stderr += d));
            child.on("error", reject);
            child.on("close", (code) => {
              signal?.removeEventListener("abort", stop);
              if (signal?.aborted) return reject(signal.reason);
              if (code !== 0 || !existsSync(out)) return reject(new Error(`The --tts-command failed (exit ${code}) for "${sentence}".\n${stderr.trim()}`));
              resolve();
            });
            // Commands may read DRAWCAST_TEXT instead of stdin and close the pipe early.
            child.stdin.on("error", () => {});
            child.stdin.end(sentence);
          });
          return await readWav(out);
        } finally {
          await rm(out, { force: true });
        }
      };
    },
  };
}

export interface VoiceOptions {
  /** the script's `voice`, or the `--voice` flag */
  spec?: string;
  /** everything the script says, to pick a voice by language */
  narration: string;
  ttsCommand?: string;
  log: (line: string) => void;
}

/** A paid voice: never a fallback, and its key is looked for only when it is about to speak. */
function minimaxVoice(spec: string, log: (line: string) => void): Voice {
  const parsed = parseMinimaxVoice(spec);
  return {
    name: MINIMAX_PREFIX + spec,
    key: sha("minimax", parsed.model, parsed.voiceId, "pcm-32000"),
    open: (signal, speed) => openMinimaxVoice(parsed, log, signal, speed),
    // MiniMax limits requests per minute; past a few at once a render only meets the limit sooner
    parallel: 3,
    // the model paces a faster sentence itself, rather than having it squeezed afterwards
    nativeSpeed: true,
  };
}

export async function resolveVoice(o: VoiceOptions): Promise<Voice> {
  if (o.ttsCommand) return commandVoice(o.ttsCommand);
  if (o.spec?.startsWith("edge:")) throw new Error("Edge TTS was removed. Omit the voice or choose maple for English or lin for Mandarin.");
  if (o.spec?.startsWith(MINIMAX_PREFIX)) return minimaxVoice(o.spec.slice(MINIMAX_PREFIX.length).trim(), o.log);
  // with a MiniMax key on hand, an unnamed voice is MiniMax's rather than the local one
  if (!o.spec && minimaxKey()) return minimaxVoice(isCjk(o.narration) ? "hunyin_6" : "English_magnetic_voiced_man", o.log);
  const name = o.spec || (isCjk(o.narration) ? "lin" : "maple");
  // a built-in voice, or one of the model's speakers by its own name
  if (Object.hasOwn(BUILT_IN, name)) {
    const voice = BUILT_IN[name];
    return kokoro(name, voice.speaker, voice.mix, o.log);
  }
  if (SPEAKERS.includes(name)) return kokoro(name, name, undefined, o.log);
  throw new Error(`There is no voice called "${name}". Built-in voices: ${Object.keys(BUILT_IN).join(", ")}. MiniMax voices start with "${MINIMAX_PREFIX}".`);
}
