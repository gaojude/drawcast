/** Reading and writing mono WAV files, which is all the audio the pipeline passes around. */
import { readFile, writeFile } from "node:fs/promises";

export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

export async function readWav(file: string): Promise<Audio> {
  const buf = await readFile(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file.`);
  let format = 1;
  let channels = 1;
  let sampleRate = 0;
  let bits = 16;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format field
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * channels));
      const read: (offset: number) => number =
        format === 3 && bits === 32
          ? (o) => buf.readFloatLE(o)
          : format === 1 && bits === 16
            ? (o) => buf.readInt16LE(o) / 32768
            : format === 1 && bits === 24
              ? (o) => buf.readIntLE(o, 3) / 8388608
              : format === 1 && bits === 32
                ? (o) => buf.readInt32LE(o) / 2147483648
                : () => {
                    throw new Error(`${file}: unsupported WAV encoding (format ${format}, ${bits} bit).`);
                  };
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += read(body + (i * channels + c) * bytes);
        samples[i] = sum / channels;
      }
      return { samples, sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${file} has no audio data.`);
}

/** Samples as 16-bit numbers, low byte first: what a WAV file holds, and what ffmpeg calls `s16le`. */
export function pcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return buf;
}

export function encodeWav({ samples, sampleRate }: Audio): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples.length * 2, 40);
  pcm16(samples).copy(buf, 44);
  return buf;
}

export const writeWav = (file: string, audio: Audio) => writeFile(file, encodeWav(audio));

/** Linear resampling; good enough for speech going into a video. */
export function resample(audio: Audio, sampleRate: number): Audio {
  if (audio.sampleRate === sampleRate) return audio;
  const ratio = audio.sampleRate / sampleRate;
  const out = new Float32Array(Math.floor(audio.samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const k = Math.floor(at);
    const next = Math.min(k + 1, audio.samples.length - 1);
    out[i] = audio.samples[k] + (audio.samples[next] - audio.samples[k]) * (at - k);
  }
  return { samples: out, sampleRate };
}

/**
 * The same speech faster or slower, at the same pitch.
 *
 * Short overlapping windows of the input are laid down closer together or further apart. Each window
 * is taken from near where the speed says it should come, at the offset that continues the previous
 * one most smoothly, which is what keeps the pitch (this is the WSOLA method).
 */
export function changeTempo(audio: Audio, speed: number): Audio {
  if (Math.abs(speed - 1) < 0.005) return audio;
  const { samples, sampleRate } = audio;
  const size = 2 * Math.round(0.015 * sampleRate);
  const hop = size / 2;
  const reach = Math.round(0.01 * sampleRate);
  if (samples.length < size * 2) return audio;

  const out = new Float32Array(Math.ceil(samples.length / speed) + size);
  const hann = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  let length = 0;
  // where in the input the previous window would have gone on to
  let follow = 0;
  for (let k = 0; ; k++) {
    const want = Math.round(k * hop * speed);
    if (want + size > samples.length) break;
    let from = want;
    if (k > 0) {
      let best = -Infinity;
      for (let shift = -reach; shift <= reach; shift += 2) {
        const start = want + shift;
        if (start < 0 || start + size > samples.length) continue;
        let match = 0;
        for (let i = 0; i < size && follow + i < samples.length; i += 4) match += samples[start + i] * samples[follow + i];
        if (match > best) [best, from] = [match, start];
      }
    }
    for (let i = 0; i < size; i++) out[k * hop + i] += samples[from + i] * hann[i];
    follow = from + hop;
    length = k * hop + size;
  }
  return { samples: out.subarray(0, length), sampleRate };
}

/** Cut the silence off both ends, keeping `keep` seconds of it. */
export function trimSilence(audio: Audio, keep = 0.03, threshold = 0.01): Audio {
  const { samples, sampleRate } = audio;
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  const pad = Math.round(keep * sampleRate);
  return { samples: samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad)), sampleRate };
}
