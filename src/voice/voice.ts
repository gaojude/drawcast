/**
 * The voices. A voice says one sentence at a time and returns the audio.
 *
 * By default a script is spoken by one of Microsoft's online voices (`edge:...`), and by the built-in
 * engine when that cannot be had. The built-in engine is Kokoro (run by sherpa-onnx, on the CPU), a small
 * model with a fixed set of speakers for Chinese and English. `--tts-command` swaps the engine for any
 * program that turns text into a WAV file.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { cacheDir } from "../paths.ts";
import { isCjk } from "../shared/text.ts";
import { EDGE_PREFIX, EDGE_VOICES, openEdgeVoice } from "./edge.ts";
import { type ModelFiles, ensureModels } from "./models.ts";
import { normalize } from "./normalize.ts";
import { type Dictionaries, parseDictionary, toTokens } from "./tokenize.ts";
import { type Audio, readWav } from "./wav.ts";

export interface Voice {
  /** Identifies the voice and its settings; audio is cached under it. */
  key: string;
  /** Gets ready to speak (loads the model). Returns the function that says one sentence. */
  open(): Promise<(sentence: string) => Promise<Audio>>;
  /** The voice that says the whole script instead if this one cannot (no edge-tts, no connection). */
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
  // the first voice of each language is the one a script gets when its online voice cannot be had
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
const TOKENS = "tokens-1";
/** The model takes about 510 tokens at a time. A sentence is far shorter unless it has no commas at all. */
const MAX_TOKENS = 480;

async function dictionaries(model: ModelFiles): Promise<Dictionaries> {
  const english = parseDictionary(await readFile(model.english, "utf8"));
  // Letter names get entries of their own (ltra .. ltrz) for spelling out acronyms, which frees "a" to be
  // the article. The dictionary gives both articles their stressed forms.
  for (const letter of "abcdefghijklmnopqrstuvwxyz") english.set(`ltr${letter}`, english.get(letter) ?? []);
  english.set("a", ["ɐ"]);
  english.set("the", ["ð", "ə"]);
  return { english, chinese: parseDictionary(await readFile(model.chinese, "utf8")) };
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
  // write beside the target and rename, so an interrupted write is never mistaken for the finished file
  await writeFile(`${target}.part`, Buffer.from(floats.buffer));
  await rename(`${target}.part`, target);
}

const MIXES: Record<string, [speaker: string, share: number]> = Object.fromEntries(Object.values(BUILT_IN).flatMap((v) => (v.mix ? [[v.speaker, v.mix]] : [])));

/** The speakers file with the built-in mixes in it, made the first time it is needed. */
async function mixedSpeakers(model: ModelFiles): Promise<string> {
  const target = path.join(path.dirname(model.voices), `voices-${sha(JSON.stringify(MIXES))}.bin`);
  if (!existsSync(target)) await mixSpeakers(model.voices, target, SPEAKERS, MIXES);
  return target;
}

function kokoro(speaker: string, mix: BuiltIn["mix"], log: (line: string) => void): Voice {
  return {
    key: sha("kokoro-v1.1", TOKENS, speaker, mix?.join(" ") ?? "", String(PACE.zh), String(PACE.en)),
    async open() {
      const model = await ensureModels(log);
      const dict = await dictionaries(model);
      const lexicon = { get: (word: string) => dict.english.get(word)?.join(" ") };
      const tokensOf = (text: string) => {
        const normalized = normalize(text, lexicon);
        // pronunciations made up for this text's words (`refactoring` from `refactor`)
        for (const [word, phones] of normalized.entries) dict.english.set(word, phones.split(" "));
        return toTokens(normalized.text, dict);
      };

      const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
      const tts = new sherpa.OfflineTts({
        model: {
          kokoro: { model: model.model, voices: mix ? await mixedSpeakers(model) : model.voices, tokens: model.tokens },
          numThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
          provider: "cpu",
        },
      });
      if (tts.numSpeakers !== SPEAKERS.length) throw new Error(`The speech model in ${path.dirname(model.model)} is not the one drawcast expects. Delete that folder and try again.`);
      const sid = SPEAKERS.indexOf(speaker);

      return async (sentence) => {
        const tokens = tokensOf(sentence);
        if (!tokens.some((t) => /[^,.;?! ]/.test(t))) throw new Error(`There is nothing the voice can say in: "${sentence}"`);
        const speed = PACE[isCjk(sentence) ? "zh" : "en"];
        const out = await tts.generateAsync({
          text: "",
          sid,
          speed,
          enableExternalBuffer: false,
          generationConfig: new sherpa.GenerationConfig({
            sid,
            speed,
            tokens: [tokens],
            // left alone, the engine shortens every pause to a fifth
            silenceScale: 1,
            // and says each clause on its own; a sentence sounds better said whole
            extra: { min_words_in_sentence: tokens.length <= MAX_TOKENS ? MAX_TOKENS : 5 },
          }),
        });
        if (!out.samples?.length) throw new Error(`The voice could not say: "${sentence}"`);
        return { samples: Float32Array.from(out.samples), sampleRate: out.sampleRate };
      };
    },
  };
}

/** A voice that runs a program: the text arrives on stdin, and the program writes a WAV to $DRAWCAST_OUT. */
function commandVoice(command: string): Voice {
  return {
    key: sha("command", command),
    async open() {
      const dir = path.join(cacheDir(), "tmp");
      await mkdir(dir, { recursive: true });
      let n = 0;
      return (sentence) =>
        new Promise<Audio>((resolve, reject) => {
          const out = path.join(dir, `say-${process.pid}-${n++}.wav`);
          const child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, DRAWCAST_OUT: out, DRAWCAST_TEXT: sentence } });
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0 || !existsSync(out)) return reject(new Error(`The --tts-command failed (exit ${code}) for "${sentence}".\n${stderr.trim()}`));
            readWav(out).then(async (audio) => {
              await rm(out, { force: true });
              resolve(audio);
            }, reject);
          });
          child.stdin.end(sentence);
        });
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

const edgeVoice = (name: string): Voice => ({ key: sha("edge", name), open: () => openEdgeVoice(name) });

/**
 * Left unset, a script gets the first online voice of its language, and the first built-in one if the
 * online voice cannot speak. A voice the script names is used as it is, with nothing to fall back on.
 */
export async function resolveVoice(o: VoiceOptions): Promise<Voice> {
  if (o.ttsCommand) return commandVoice(o.ttsCommand);
  if (o.spec?.startsWith(EDGE_PREFIX)) {
    const name = o.spec.slice(EDGE_PREFIX.length).trim();
    if (!name) throw new Error(`"${EDGE_PREFIX}" needs the name of a voice after it, such as "${EDGE_PREFIX}en-US-EmmaMultilingualNeural".`);
    return edgeVoice(name);
  }
  const language = isCjk(o.narration) ? "zh" : "en";
  if (!o.spec) {
    const builtIn = Object.keys(BUILT_IN).find((v) => BUILT_IN[v].language === language)!;
    const online = EDGE_VOICES.find((v) => v.language === language)!;
    return { ...edgeVoice(online.name), fallback: await resolveVoice({ ...o, spec: builtIn }) };
  }
  const name = o.spec;
  // a built-in voice, or one of the model's speakers by its own name
  const voice = BUILT_IN[name] ?? (SPEAKERS.includes(name) ? { speaker: name } : undefined);
  if (!voice) throw new Error(`There is no voice called "${name}". Built-in voices: ${Object.keys(BUILT_IN).join(", ")}. Online voices start with "${EDGE_PREFIX}".`);
  return kokoro(voice.speaker, voice.mix, o.log);
}
