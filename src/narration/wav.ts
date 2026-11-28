/** Reading and writing mono WAV files, which is all the audio the pipeline passes around. */
import { open, readFile, writeFile } from "node:fs/promises";

export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

function wavHeader(buf: Buffer, file: string, fileSize = buf.length) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file.`);
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let blockAlign = 0;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("ascii", at, at + 4);
    const body = at + 8;
    let size = buf.readUInt32LE(at + 4);
    // A WAV streamed by ffmpeg uses an unknown data size until end of file.
    if (id === "data" && size === 0xffffffff) size = fileSize - body;
    if (size > fileSize - body) throw new Error(`${file} has a truncated WAV chunk.`);
    if (id === "fmt ") {
      if (size < 16) throw new Error(`${file} has an incomplete WAV format.`);
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      blockAlign = buf.readUInt16LE(body + 12);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format field
      if (format === 0xfffe) {
        if (size < 40) throw new Error(`${file} has an incomplete extensible WAV format.`);
        format = buf.readUInt16LE(body + 24);
      }
    } else if (id === "data") {
      if (!sampleRate || !channels) throw new Error(`${file} has no valid WAV format before its audio data.`);
      if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && [32, 64].includes(bits))) {
        throw new Error(`${file}: unsupported WAV encoding (format ${format}, ${bits} bit).`);
      }
      const bytes = bits / 8;
      if (blockAlign !== bytes * channels) throw new Error(`${file} has inconsistent WAV frame alignment.`);
      const frames = size / (bytes * channels);
      if (!frames || !Number.isInteger(frames)) throw new Error(`${file} has empty or incomplete WAV audio data.`);
      return { frames, sampleRate, body, channels, bytes, format };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${file} has no audio data.`);
}

export async function readWavInfo(file: string) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    // For a standard PCM header, snapshots need only the header and file size.
    if (bytesRead === 44 && header.toString("ascii", 12, 16) === "fmt " && header.readUInt32LE(16) === 16 && header.toString("ascii", 36, 40) === "data") {
      return wavHeader(header, file, (await handle.stat()).size);
    }
    return wavHeader(await handle.readFile(), file);
  } finally {
    await handle.close();
  }
}

export async function readWav(file: string): Promise<Audio> {
  const buf = await readFile(file);
  const { frames, sampleRate, body, channels, bytes, format } = wavHeader(buf, file);
  const scale = 2 ** (bytes * 8 - 1);
  const read = format === 3 ? (o: number) => bytes === 4 ? buf.readFloatLE(o) : buf.readDoubleLE(o)
    : bytes === 1 ? (o: number) => (buf[o] - 128) / 128
    : (o: number) => buf.readIntLE(o, bytes) / scale;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(body + (i * channels + c) * bytes);
    samples[i] = sum / channels;
    if (format === 3 && !Number.isFinite(samples[i])) throw new Error(`${file} contains a non-finite WAV sample.`);
  }
  return { samples, sampleRate };
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
