/**
 * Speaks a script: one audio clip per step, and for each clip the times at which its words are said.
 *
 * A step is spoken sentence by sentence. The voice does not report when each word falls, so a word's
 * time is estimated inside its sentence from syllable counts. Sentence boundaries are exact, which keeps
 * the estimate within a fraction of a second.
 */
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { cacheDir } from "../paths.ts";
import { sentences, tokenLength, tokens } from "../shared/text.ts";
import type { Script, StepAudio, TimedToken } from "../shared/types.ts";
import type { Voice } from "./voice.ts";
import { type Audio, changeTempo, readWav, resample, trimSilence, writeWav } from "./wav.ts";

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
  const steps = script.steps.map((step) => (step.say?.trim() ? stepAudio(sentences(step.say).map((sentence) => ({ sentence, seconds: estimateSeconds(sentence) }))) : null));
  return { steps, clips: steps.map(() => null) };
}

/**
 * `speed` is applied to the finished speech, so a sentence is spoken once whatever speeds it is played at.
 *
 * `spoken` hears of each step as soon as it and every step before it are spoken, in order, which lets
 * the start of a video be made while the rest of it is still being said.
 */
export async function narrate(
  script: Script,
  voice: Voice,
  speed: number,
  log: (line: string) => void,
  spoken?: (index: number, step: StepAudio | null, clip: Audio | null) => void,
): Promise<Narration> {
  const perStep = script.steps.map((step) => (step.say?.trim() ? sentences(step.say) : []));
  const all = [...new Set(perStep.flat())];
  const dir = path.join(cacheDir(), "speech", voice.key);
  await mkdir(dir, { recursive: true });
  const fileOf = (sentence: string) => path.join(dir, `${createHash("sha256").update(sentence).digest("hex").slice(0, 24)}.wav`);

  const missing = all.filter((s) => !existsSync(fileOf(s)));
  /** the sentences whose speech is in the cache */
  const have = new Set(all.filter((s) => !missing.includes(s)));
  const clips: (Audio | null)[] = [];
  const steps: (StepAudio | null)[] = [];
  /** Puts together the steps whose sentences are all there, in order, up to the first that is not. */
  const assemble = async () => {
    while (steps.length < perStep.length && perStep[steps.length].every((s) => have.has(s))) {
      const list = perStep[steps.length];
      const parts = await Promise.all(list.map(async (s) => changeTempo(resample(await readWav(fileOf(s)), SAMPLE_RATE), speed)));
      clips.push(list.length ? concat(parts, SENTENCE_GAP) : null);
      steps.push(list.length ? stepAudio(list.map((sentence, i) => ({ sentence, seconds: parts[i].samples.length / SAMPLE_RATE }))) : null);
      spoken?.(steps.length - 1, steps[steps.length - 1], clips[clips.length - 1]);
    }
  };
  // one run after another: each takes up where the last one stopped
  let assembling = Promise.resolve();
  const more = () => {
    assembling = assembling.then(assemble);
    // a failure is reported where `assembling` is awaited, below
    assembling.catch(() => {});
  };
  more();

  if (missing.length) {
    const say = await voice.open();
    // Sentences do not depend on each other, so a voice that can says several at once.
    let next = 0;
    let failed = false;
    const speak = async () => {
      // once a sentence has failed the render is over, and no more are started
      while (!failed && next < missing.length) {
        const i = next++;
        const sentence = missing[i];
        log(`  speaking ${i + 1}/${missing.length}: ${sentence.length > 60 ? `${sentence.slice(0, 57)}...` : sentence}`);
        try {
          const audio = trimSilence(await say(sentence));
          // written beside the target and renamed, so an interrupted render leaves no half a sentence in the cache
          const part = `${fileOf(sentence)}.${process.pid}.part`;
          await writeWav(part, audio);
          await rename(part, fileOf(sentence));
        } catch (e) {
          failed = true;
          throw e;
        }
        have.add(sentence);
        more();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(voice.parallel ?? 1, missing.length)) }, speak));
  }

  await assembling;
  return { steps, clips };
}
