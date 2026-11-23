/**
 * The voices. A voice says one sentence at a time and returns the audio.
 *
 * The built-in engine is ZipVoice (run by sherpa-onnx, on the CPU), which speaks Chinese and English in
 * the manner of a short reference clip. The clips in `assets/voices` are the built-in voices; a script can
 * bring its own. `--tts-command` swaps the engine for any program that turns text into a WAV file.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { cacheDir, packageRoot } from "../paths.ts";
import { isCjk } from "../shared/text.ts";
import type { VoiceSpec } from "../shared/types.ts";
import { ensureModels } from "./models.ts";
import { normalize } from "./normalize.ts";
import { type Dictionaries, parseDictionary, toTokens } from "./tokenize.ts";
import { type Audio, readWav } from "./wav.ts";

export interface Voice {
  /** Identifies the voice and its settings; audio is cached under it. */
  key: string;
  /** Gets ready to speak (loads the model). Returns the function that says one sentence. */
  open(): Promise<(sentence: string) => Promise<Audio>>;
}

interface BuiltIn {
  language: "zh" | "en";
  description: string;
  transcript: string;
}

const voicesDir = path.join(packageRoot, "assets", "voices");

export const builtInVoices = (): Record<string, BuiltIn> => JSON.parse(readFileSync(path.join(voicesDir, "voices.json"), "utf8"));

const sha = (...parts: (string | Uint8Array)[]) => parts.reduce((h, p) => h.update(p).update("\0"), createHash("sha256")).digest("hex").slice(0, 20);

/** Sampling steps of the model: more is slower and a little cleaner. */
const STEPS = 8;

async function dictionaries(chineseFile: string): Promise<Dictionaries> {
  const english = gunzipSync(await readFile(path.join(packageRoot, "assets", "lexicon-en.txt.gz"))).toString("utf8");
  return { english: parseDictionary(english), chinese: parseDictionary(await readFile(chineseFile, "utf8")) };
}

function zipVoice(clip: Audio, transcript: string, speed: number, log: (line: string) => void): Voice {
  const key = sha("zipvoice-distill-zh-en", String(STEPS), speed.toFixed(2), transcript, new Uint8Array(clip.samples.buffer, clip.samples.byteOffset, clip.samples.byteLength));
  return {
    key,
    async open() {
      const model = await ensureModels(log);
      const dict = await dictionaries(model.lexicon);
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
          zipvoice: { tokens: model.tokens, encoder: model.encoder, decoder: model.decoder, vocoder: model.vocoder, lexicon: model.lexicon },
          numThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
          provider: "cpu",
        },
      });
      const reference = tokensOf(transcript);

      return async (sentence) => {
        const tokens = tokensOf(sentence);
        if (!tokens.some((t) => /[^,.;?! ]/.test(t))) throw new Error(`There is nothing the voice can say in: "${sentence}"`);
        const out = await tts.generateAsync({
          text: "",
          sid: 0,
          speed,
          enableExternalBuffer: false,
          generationConfig: new sherpa.GenerationConfig({
            referenceAudio: clip.samples,
            referenceSampleRate: clip.sampleRate,
            referenceText: transcript,
            numSteps: STEPS,
            speed,
            // the first list is the clip's transcript, the second what to say
            tokens: [reference, tokens],
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
  spec?: VoiceSpec;
  speed: number;
  /** the folder the script is in; a voice clip's path is relative to it */
  baseDir: string;
  /** everything the script says, to pick a voice by language */
  narration: string;
  ttsCommand?: string;
  log: (line: string) => void;
}

export async function resolveVoice(o: VoiceOptions): Promise<Voice> {
  if (o.ttsCommand) return commandVoice(o.ttsCommand);
  if (typeof o.spec === "object") {
    const clip = await readWav(path.resolve(o.baseDir, o.spec.clip));
    const seconds = clip.samples.length / clip.sampleRate;
    if (seconds < 2 || seconds > 15) throw new Error(`The voice clip is ${seconds.toFixed(1)} s long; use 3 to 10 seconds of clear speech.`);
    return zipVoice(clip, o.spec.transcript, o.speed, o.log);
  }
  const voices = builtInVoices();
  const language = isCjk(o.narration) ? "zh" : "en";
  const name = o.spec ?? Object.keys(voices).find((v) => voices[v].language === language)!;
  const voice = voices[name];
  if (!voice) throw new Error(`There is no voice called "${name}". Built-in voices: ${Object.keys(voices).join(", ")}.`);
  return zipVoice(await readWav(path.join(voicesDir, `${name}.wav`)), voice.transcript, o.speed, o.log);
}
