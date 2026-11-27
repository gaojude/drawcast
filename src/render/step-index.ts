import { open, writeFile } from "node:fs/promises";

/** A Drawcast top-level MP4 user-extension box. Other players skip its payload. */
const uuid = Buffer.from("9a67313d142c4b19815027658dc9286c", "hex");
const prefix = 36; // size, "uuid", UUID, version, total frame count
const missing = "This MP4 has no usable Drawcast step index. Inspect it with --at or --motion, or render the script again to use --step.";

export interface StepIndex {
  frames: number;
  stepFrames: number[];
}

/** Use the same i / fps clock as the player, including at fractional frame rates. */
export function stepFrameIndex(starts: number[], done: number[], fps: number, frames: number, cover: boolean): StepIndex {
  const firstNormal = Math.min(cover ? 1 : 0, frames - 1);
  const atOrAfter = (time: number) => {
    const i = Math.floor(time * fps);
    return i / fps < time ? i + 1 : i;
  };
  const stepFrames = done.map((time, i) => {
    const first = Math.max(firstNormal, atOrAfter(starts[i]));
    const last = i + 1 < starts.length ? atOrAfter(starts[i + 1]) - 1 : frames - 1;
    // Before a new scene, prefer the last picture still in this one. If the whole
    // step falls between frames, the first subsequent picture is the only witness.
    return Math.min(frames - 1, Math.max(first, Math.min(atOrAfter(time), last)));
  });
  return { frames, stepFrames };
}

export async function appendStepIndex(file: string, index: StepIndex, signal?: AbortSignal) {
  const box = Buffer.alloc(prefix + index.stepFrames.length * 8);
  box.writeUInt32BE(box.length);
  box.write("uuid", 4);
  uuid.copy(box, 8);
  box.writeUInt32BE(1, 24);
  box.writeDoubleBE(index.frames, 28);
  index.stepFrames.forEach((frame, i) => box.writeDoubleBE(frame, prefix + 8 * i));
  await writeFile(file, box, { flag: "a", signal });
}

export async function readStepIndex(file: string, signal?: AbortSignal): Promise<StepIndex> {
  const input = await open(file, "r");
  try {
    const { size } = await input.stat();
    const header = Buffer.alloc(24);
    // Seek across mdat and moov. A large movie costs the same as a short one.
    for (let offset = 0; offset + 8 <= size;) {
      signal?.throwIfAborted();
      if ((await input.read(header, 0, 8, offset)).bytesRead !== 8) break;
      const type = header.toString("latin1", 4, 8);
      let length = header.readUInt32BE(0);
      let base = 8;
      if (length === 1) {
        if ((await input.read(header, 0, 8, offset + 8)).bytesRead !== 8) break;
        length = Number(header.readBigUInt64BE());
        base = 16;
      } else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < base || length > size - offset) break;
      if (type === "uuid" && length >= base + 16) {
        if ((await input.read(header, 0, 16, offset + base)).bytesRead !== 16) break;
        if (header.subarray(0, 16).equals(uuid)) {
          const bytes = length - base - 16;
          // Even a forged length in a foreign MP4 must not allocate a movie-sized buffer.
          if (bytes < 20 || bytes > 64 * 1024 * 1024 || (bytes - 12) % 8) break;
          const data = Buffer.alloc(bytes);
          if ((await input.read(data, 0, bytes, offset + base + 16)).bytesRead !== bytes || data.readUInt32BE(0) !== 1) break;
          const frames = data.readDoubleBE(4);
          if (!Number.isSafeInteger(frames) || frames < 1) break;
          const stepFrames: number[] = [];
          for (let pos = 12; pos < bytes; pos += 8) {
            const frame = data.readDoubleBE(pos);
            if (!Number.isSafeInteger(frame) || frame < (stepFrames.at(-1) ?? 0) || frame >= frames) throw new Error(missing);
            stepFrames.push(frame);
          }
          return { frames, stepFrames };
        }
      }
      offset += length;
    }
    throw new Error(missing);
  } finally {
    await input.close();
  }
}
