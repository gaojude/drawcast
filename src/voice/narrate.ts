/**
 * Speaks a script: one audio clip per step, and for each clip the times at which its words are said.
 *
 * A step is spoken sentence by sentence. The voice does not report when each word falls, so a word's
 * time is estimated inside its sentence from syllable counts. Sentence boundaries are exact, which keeps
 * the estimate within a fraction of a second.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { cacheDir } from "../paths.ts";
import { sentences, tokenLength, tokens } from "../shared/text.ts";
import type { Script, StepAudio, TimedToken } from "../shared/types.ts";
import type { Voice } from "./voice.ts";
import { writeFileAtomic } from "../shared/files.ts";
import { type Audio, changeTempo, encodeWav, readWav, readWavInfo, resample, tempoFrames, trimSilence } from "./wav.ts";

export const SAMPLE_RATE = 48000;
/** Silence between two sentences of a step. */
const SENTENCE_GAP = 0.28;
/** A comma is worth about this many syllables of pause. */
const COMMA = 1.2;

export interface Narration {
  /** per step: the timing the renderer needs, or null for a silent step */
  steps: (StepAudio | null)[];
  clips: (Audio | null)[];
}

/** Rough timing for a sentence nobody has spoken yet, for `check` and `snapshot`. */
const SYLLABLES_PER_SECOND = 4.2;
export const estimateSeconds = (sentence: string) => 0.3 + tokens(sentence).reduce((n, t) => n + tokenLength(t), 0) / SYLLABLES_PER_SECOND;

/** When each token of a sentence lasting `duration` starts. */
function timeTokens(sentence: string, duration: number): TimedToken[] {
  const pieces = sentence.toLowerCase().replace(/[‘’]/g, "'").split(/([,;:，；：、—]+)/);
  const marks: { token: string; at: number }[] = [];
  let length = 0;
  pieces.forEach((piece, i) => {
    if (i % 2) {
      length += COMMA;
      return;
    }
    for (const token of tokens(piece)) {
      marks.push({ token, at: length });
      length += tokenLength(token);
    }
  });
  return marks.map((m) => ({ token: m.token, t: length ? (m.at / length) * duration : 0 }));
}

function concat(parts: Audio[], gap: number): Audio {
  const silence = Math.round(gap * SAMPLE_RATE);
  const out = new Float32Array(parts.reduce((n, p) => n + p.samples.length, 0) + silence * Math.max(0, parts.length - 1));
  let at = 0;
  for (const p of parts) {
    out.set(p.samples, at);
    at += p.samples.length + silence;
  }
  return { samples: out, sampleRate: SAMPLE_RATE };
}

function stepAudio(spoken: { sentence: string; seconds: number }[]): StepAudio {
  const out: StepAudio = { duration: 0, tokens: [], captions: [] };
  let at = 0;
  for (const { sentence, seconds } of spoken) {
    out.tokens.push(...timeTokens(sentence, seconds).map((w) => ({ token: w.token, t: at + w.t })));
    out.captions.push({ text: sentence, t0: at, t1: at + seconds + SENTENCE_GAP });
    at += seconds + SENTENCE_GAP;
  }
  out.duration = Math.max(0, at - SENTENCE_GAP);
  return out;
}

/** Timing without a voice: every sentence is assumed to take as long as its syllables suggest. */
export function estimateNarration(script: Script): Narration {
  const steps = script.steps.map((step) => (step.say?.trim() ? stepAudio(sentences(step.say).map((sentence) => ({ sentence, seconds: estimateSeconds(sentence) / (script.speed ?? 1) }))) : null));
  return { steps, clips: steps.map(() => null) };
}

/** How much faster a voice's recordings are still to be made: not at all when it spoke at the speed itself. */
const stretchOf = (voice: Voice, speed: number) => (voice.nativeSpeed ? 1 : speed);
/** A voice that speaks at the speed itself keeps each speed's recordings apart. */
const speechDir = (voice: Voice, speed: number) =>
  path.join(cacheDir(), "speech", voice.nativeSpeed && Math.abs(speed - 1) >= 0.005 ? `${voice.key}-x${speed}` : voice.key);
const speechFile = (voice: Voice, speed: number, sentence: string) => path.join(speechDir(voice, speed), `${createHash("sha256").update(sentence).digest("hex").slice(0, 24)}.wav`);

async function cachedSeconds(voice: Voice, all: string[], speed: number, signal?: AbortSignal): Promise<Map<string, number>> {
  const seconds = new Map<string, number>();
  for (const sentence of all) {
    signal?.throwIfAborted();
    const info = await readWavInfo(speechFile(voice, speed, sentence)).catch(() => null);
    if (!info) continue;
    const resampledFrames = Math.floor(info.frames / (info.sampleRate / SAMPLE_RATE));
    seconds.set(sentence, tempoFrames(resampledFrames, SAMPLE_RATE, stretchOf(voice, speed)) / SAMPLE_RATE);
  }
  return seconds;
}

/**
 * Timing for `snapshot`, without speaking: a sentence the voice has already said (by an earlier render)
 * takes as long as it did then, and any other as long as its syllables suggest. Once a script has been
 * rendered, its snapshots are at the times of the video. `voice` is tried first, then its fallback.
 */
export async function cachedNarration(script: Script, voice: Voice, speed: number, signal?: AbortSignal): Promise<Narration & { cached: number; total: number; voice: string | null }> {
  signal?.throwIfAborted();
  const perStep = script.steps.map((step) => (step.say?.trim() ? sentences(step.say) : []));
  const all = [...new Set(perStep.flat())];
  // the voice that has the most of the script, so that one video's timing comes from one voice
  let best: Voice = voice;
  let seconds = new Map<string, number>();
  for (let v: Voice | undefined = voice; v; v = v.fallback) {
    const candidate = await cachedSeconds(v, all, speed, signal);
    if (candidate.size > seconds.size) [best, seconds] = [v, candidate];
    if (seconds.size === all.length) break;
  }
  const steps = perStep.map((list) => (list.length ? stepAudio(list.map((sentence) => ({ sentence, seconds: seconds.get(sentence) ?? estimateSeconds(sentence) / speed }))) : null));
  return { steps, clips: steps.map(() => null), cached: seconds.size, total: all.length, voice: seconds.size ? best.name : null };
}

/** Whoever wants to hear a narration as it is spoken, so as to make the start of a video meanwhile. */
export interface Listener {
  /** Called with each step, in order, as soon as it and every step before it are spoken. */
  spoken(index: number, step: StepAudio | null, clip: Audio | null): void;
  /**
   * The voice could not go on, and another one is saying the whole script from the start. The steps
   * reported so far were in the first voice, and are to be forgotten: they are reported again.
   */
  startOver(): void;
}

/**
 * `speed` is applied to the finished speech, so a sentence is spoken once whatever speeds it is played
 * at; except by a voice with `nativeSpeed`, which is asked to speak at that speed.
 */
export async function narrate(script: Script, voice: Voice, speed: number, log: (line: string) => void, listener?: Listener, signal?: AbortSignal): Promise<Narration> {
  signal?.throwIfAborted();
  const perStep = script.steps.map((step) => (step.say?.trim() ? sentences(step.say) : []));
  const all = [...new Set(perStep.flat())];
  const fileOf = (sentence: string) => speechFile(voice, speed, sentence);
  const stretch = stretchOf(voice, speed);

  const have = new Set((await cachedSeconds(voice, all, speed, signal)).keys());
  const missing = all.filter((s) => !have.has(s));
  if (missing.length) await mkdir(speechDir(voice, speed), { recursive: true });
  signal?.throwIfAborted();
  log(`  voice: ${voice.name}, ${all.length} sentence(s), ${missing.length ? `${all.length - missing.length} from the cache` : "all from the cache"}`);
  const clips: (Audio | null)[] = [];
  const steps: (StepAudio | null)[] = [];
  /** set when the voice gives up: no more sentences are started, and no more steps reported */
  let failed = false;
  /** Puts together the steps whose sentences are all there, in order, up to the first that is not. */
  const assemble = async () => {
    while (!failed && steps.length < perStep.length && perStep[steps.length].every((s) => have.has(s))) {
      signal?.throwIfAborted();
      const list = perStep[steps.length];
      const parts = await Promise.all(list.map(async (s) => changeTempo(resample(await readWav(fileOf(s)), SAMPLE_RATE), stretch)));
      if (failed) return;
      signal?.throwIfAborted();
      clips.push(list.length ? concat(parts, SENTENCE_GAP) : null);
      steps.push(list.length ? stepAudio(list.map((sentence, i) => ({ sentence, seconds: parts[i].samples.length / SAMPLE_RATE }))) : null);
      listener?.spoken(steps.length - 1, steps[steps.length - 1], clips[clips.length - 1]);
    }
  };
  // one run after another: each takes up where the last one stopped
  let assembling = Promise.resolve();
  const more = () => {
    assembling = assembling.then(assemble);
    // a failure is reported where `assembling` is awaited, below
    assembling.catch(() => { failed = true; });
  };
  more();

  if (missing.length) {
    let cacheError: unknown;
    try {
      const say = await voice.open(signal, voice.nativeSpeed ? speed : undefined);
      // Sentences do not depend on each other, so a voice that can says several at once.
      let next = 0;
      const speak = async () => {
        while (!failed && next < missing.length) {
          signal?.throwIfAborted();
          const i = next++;
          const sentence = missing[i];
          log(`  speaking ${i + 1}/${missing.length}: ${sentence.length > 60 ? `${sentence.slice(0, 57)}...` : sentence}`);
          try {
            const audio = trimSilence(await say(sentence));
            signal?.throwIfAborted();
            if (failed) return;
            if (!audio.samples.length || !(audio.sampleRate > 0)) throw new Error(`The voice returned no usable audio for "${sentence}".`);
            await writeFileAtomic(fileOf(sentence), encodeWav(audio)).catch((e: Error) => { cacheError = e; throw e; });
          } catch (e) {
            failed = true;
            throw e;
          }
          have.add(sentence);
          more();
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(voice.parallel ?? 1, missing.length)) }, speak));
      const error = workers.find((worker) => worker.status === "rejected");
      if (error) throw error.reason;
    } catch (e) {
      failed = true;
      // a step that was being put together is let finish first, so that none of this voice's comes after this
      await assembling;
      signal?.throwIfAborted();
      if (cacheError) throw cacheError;
      if (!voice.fallback) throw e;
      // the whole script goes to the other voice, so that one video never has two voices in it
      log(`  the online voice could not speak, so the built-in voice will: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      if (steps.length) listener?.startOver();
      return narrate(script, voice.fallback, speed, log, listener, signal);
    }
  }

  await assembling;
  signal?.throwIfAborted();
  return { steps, clips };
}
