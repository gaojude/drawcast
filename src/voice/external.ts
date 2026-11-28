import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sentences, tokens } from "../shared/text.ts";
import type { Script, StepAudio } from "../shared/types.ts";
import { type Narration, SAMPLE_RATE, SENTENCE_GAP, timeTokens } from "./narrate.ts";
import { readWav, readWavInfo, resample } from "./wav.ts";

export function narrationRequest(script: Script) {
  const steps = script.steps.map((step, i) => ({
    sentences: sentences(step.say ?? "").map((text, j) => ({
      id: "s" + (i + 1) + "." + (j + 1), text, tokens: tokens(text),
    })),
  }));
  const fingerprint = createHash("sha256").update(JSON.stringify(steps)).digest("hex");
  return { version: 1, fingerprint, steps };
}

type Entry = Record<string, unknown>;
const isObject = (v: unknown): v is Entry => typeof v === "object" && v !== null && !Array.isArray(v);

function frame(ms: unknown, field: string): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new Error(field + " must be a finite, nonnegative timestamp in milliseconds.");
  }
  return Math.round(ms * SAMPLE_RATE / 1000);
}

interface Recording {
  frames: number;
  samples?: Float32Array;
}

async function recording(file: string, withSamples: boolean): Promise<Recording> {
  if (withSamples) {
    const { samples } = resample(await readWav(file), SAMPLE_RATE);
    return { frames: samples.length, samples };
  }
  const info = await readWavInfo(file);
  return { frames: Math.floor(info.frames / (info.sampleRate / SAMPLE_RATE)) };
}

/** Assemble step-local timing from file-local positions on the same sample clock as the mixer. */
export async function importNarration(script: Script, file: string, withSamples: boolean, signal?: AbortSignal): Promise<Narration & { inputs: string[] }> {
  const request = narrationRequest(script);
  let result: unknown;
  try {
    result = JSON.parse((await readFile(file, { encoding: "utf8", signal })).replace(/^\uFEFF/, ""));
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error("Could not read narration result " + file + ": " + (error as Error).message);
  }
  if (!isObject(result) || result.version !== 1 || !Array.isArray(result.sentences)) {
    throw new Error("Expected a version 1 narration result with a sentences array in " + file);
  }
  if (result.fingerprint !== request.fingerprint) throw new Error("Narration fingerprint differs from the script. Export the request again and check the recordings.");

  const remaining = new Set(request.steps.flatMap(step => step.sentences.map(s => s.id)));
  const entries = new Map<string, Entry>();
  for (const entry of result.sentences) {
    if (!isObject(entry) || typeof entry.id !== "string" || !remaining.delete(entry.id)) {
      throw new Error("Unknown or duplicate narration sentence ID: " + (isObject(entry) ? entry.id : entry));
    }
    entries.set(entry.id, entry);
  }
  if (remaining.size) throw new Error("Missing narration for " + [...remaining].join(", "));

  const sources = new Map<string, Recording>();
  const steps: Narration["steps"] = [];
  const clips: Narration["clips"] = [];
  for (const step of request.steps) {
    const timing: StepAudio = { duration: 0, tokens: [], captions: [] };
    const parts: { at: number; samples: Float32Array }[] = [];
    let length = 0;
    let previous: { file: string; end: number; ranged: boolean } | undefined;
    for (const sentence of step.sentences) {
      signal?.throwIfAborted();
      const entry = entries.get(sentence.id)!;
      if (typeof entry.audio !== "string" || !entry.audio.trim()) throw new Error(sentence.id + " needs an audio filename.");
      const source = path.resolve(path.dirname(file), entry.audio);
      let sound = sources.get(source);
      if (!sound) {
        sound = await recording(source, withSamples);
        sources.set(source, sound);
      }
      const ranged = entry.startMs !== undefined || entry.endMs !== undefined;
      const start = ranged ? frame(entry.startMs, sentence.id + ".startMs") : 0;
      const end = ranged ? frame(entry.endMs, sentence.id + ".endMs") : sound.frames;
      if (start >= end || end > sound.frames) throw new Error(sentence.id + " needs a nonempty range inside " + entry.audio);

      // Adjacent ranges in one take preserve the actual audio between sentences, including breaths.
      const continuous = previous?.file === source && previous.ranged && ranged;
      const copyFrom = continuous ? previous!.end : start;
      if (copyFrom > start) throw new Error(sentence.id + " overlaps or precedes the previous sentence in " + entry.audio);
      if (previous && !continuous) length += Math.round(SENTENCE_GAP * SAMPLE_RATE);
      if (sound.samples) parts.push({ at: length, samples: sound.samples.subarray(copyFrom, end) });
      const sentenceStart = length + start - copyFrom;
      length += end - copyFrom;
      const t0 = sentenceStart / SAMPLE_RATE;
      timing.captions.push({ text: sentence.text, t0, t1: length / SAMPLE_RATE });

      if (entry.tokenStartsMs === undefined) {
        for (const mark of timeTokens(sentence.text, (end - start) / SAMPLE_RATE)) {
          timing.tokens.push({ token: mark.token, t: t0 + mark.t });
        }
      } else {
        if (!Array.isArray(entry.tokenStartsMs) || entry.tokenStartsMs.length !== sentence.tokens.length) {
          throw new Error(sentence.id + " needs one tokenStartsMs timestamp per exported token.");
        }
        let last = start;
        for (const [i, ms] of entry.tokenStartsMs.entries()) {
          const at = frame(ms, sentence.id + ".tokenStartsMs");
          if (at < last || at >= end) throw new Error(sentence.id + " tokenStartsMs must be ordered and inside its sentence.");
          timing.tokens.push({ token: sentence.tokens[i], t: (sentenceStart + at - start) / SAMPLE_RATE });
          last = at;
        }
      }
      previous = { file: source, end, ranged };
    }
    timing.duration = length / SAMPLE_RATE;
    steps.push(length ? timing : null);
    const samples = withSamples && length ? new Float32Array(length) : null;
    if (samples) for (const part of parts) samples.set(part.samples, part.at);
    clips.push(samples ? { sampleRate: SAMPLE_RATE, samples } : null);
  }
  return { steps, clips, inputs: [file, ...sources.keys()] };
}
