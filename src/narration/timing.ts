import { sentences, tokenLength, tokens } from "../shared/text.ts";
import type { Script, StepAudio, TimedToken } from "../shared/types.ts";
import type { Audio } from "./wav.ts";

export const SAMPLE_RATE = 48000;
/** Silence between two sentences of a step. */
export const SENTENCE_GAP = 0.28;
/** A comma is worth about this many syllables of pause. */
const COMMA = 1.2;

export interface Narration {
  /** per step: the timing the renderer needs, or null for a silent step */
  steps: (StepAudio | null)[];
  clips: (Audio | null)[];
}

/** Rough timing for a sentence nobody has spoken yet, for previews. */
const SYLLABLES_PER_SECOND = 4.2;
export const estimateSeconds = (sentence: string) => 0.3 + tokens(sentence).reduce((n, t) => n + tokenLength(t), 0) / SYLLABLES_PER_SECOND;

/** When each token of a sentence lasting `duration` starts. */
export function timeTokens(sentence: string, duration: number): TimedToken[] {
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
