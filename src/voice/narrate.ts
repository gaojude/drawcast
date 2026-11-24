/**
 * Speaks a script: one audio clip per step, and for each clip the times at which its words are said.
 *
 * A step is spoken sentence by sentence. The voice does not report when each word falls, so a word's
 * time is estimated inside its sentence from syllable counts. Sentence boundaries are exact, which keeps
 * the estimate within a fraction of a second.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

/** `speed` is applied to the finished speech, so a sentence is spoken once whatever speeds it is played at. */
export async function narrate(script: Script, voice: Voice, speed: number, log: (line: string) => void): Promise<Narration> {
  const perStep = script.steps.map((step) => (step.say?.trim() ? sentences(step.say) : []));
  const all = [...new Set(perStep.flat())];
  const dir = path.join(cacheDir(), "speech", voice.key);
  await mkdir(dir, { recursive: true });
  const fileOf = (sentence: string) => path.join(dir, `${createHash("sha256").update(sentence).digest("hex").slice(0, 24)}.wav`);

  const missing = all.filter((s) => !existsSync(fileOf(s)));
  if (missing.length) {
    try {
      const say = await voice.open();
      for (const [i, sentence] of missing.entries()) {
        log(`  speaking ${i + 1}/${missing.length}: ${sentence.length > 60 ? `${sentence.slice(0, 57)}...` : sentence}`);
        await writeWav(fileOf(sentence), trimSilence(await say(sentence)));
      }
    } catch (e) {
      if (!voice.fallback) throw e;
      // the whole script goes to the other voice, so that one video never has two voices in it
      log(`  the online voice could not speak, so the built-in voice will: ${(e as Error).message.split("\n")[0]}`);
      return narrate(script, voice.fallback, speed, log);
    }
  }

  const clips: (Audio | null)[] = [];
  const steps: (StepAudio | null)[] = [];
  for (const list of perStep) {
    if (!list.length) {
      clips.push(null);
      steps.push(null);
      continue;
    }
    const parts = await Promise.all(list.map(async (s) => changeTempo(resample(await readWav(fileOf(s)), SAMPLE_RATE), speed)));
    clips.push(concat(parts, SENTENCE_GAP));
    steps.push(stepAudio(list.map((sentence, i) => ({ sentence, seconds: parts[i].samples.length / SAMPLE_RATE }))));
  }
  return { steps, clips };
}
