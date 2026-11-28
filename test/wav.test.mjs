import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { encodeWav, readWav, resample } from "../src/narration/wav.ts";

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "drawcast-wav-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("incomplete WAV metadata fails before resampling and streamed WAV data is accepted", async (t) => {
  const file = path.join(tempDir(t), "input.wav");
  const wav = () => encodeWav({ samples: Float32Array.of(0.25, -0.25), sampleRate: 22050 });
  for (const change of [(b) => b.writeUInt32LE(0, 24), (b) => b.writeUInt16LE(0, 22), (b) => b.writeUInt32LE(12, 16), (b) => b.writeUInt32LE(11, 40)]) {
    const buf = wav();
    change(buf);
    writeFileSync(file, buf);
    await assert.rejects(readWav(file), /WAV|audio data/);
  }
  const buf = wav();
  buf.writeUInt32LE(0xffffffff, 40);
  writeFileSync(file, buf);
  assert.equal((await readWav(file)).samples.length, 2);
});

test("stereo float WAVs downmix and resample at their declared rate", async (t) => {
  const file = path.join(tempDir(t), "float.wav");
  for (const rate of [8000, 22050, 44100, 48000, 96000]) {
    for (const bytes of [4, 8]) {
      const frames = rate / 10;
      const size = frames * 2 * bytes;
      const wav = Buffer.alloc(44 + size);
      encodeWav({ samples: Float32Array.of(0), sampleRate: rate }).copy(wav, 0, 0, 44);
      wav.writeUInt32LE(36 + size, 4);
      wav.writeUInt16LE(3, 20);
      wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(rate * 2 * bytes, 28);
      wav.writeUInt16LE(2 * bytes, 32);
      wav.writeUInt16LE(8 * bytes, 34);
      wav.writeUInt32LE(size, 40);
      for (let i = 0; i < frames * 2; i++) {
        const value = i % 2 === 0 ? -0.25 : 0.75;
        if (bytes === 4) wav.writeFloatLE(value, 44 + bytes * i);
        else wav.writeDoubleLE(value, 44 + bytes * i);
      }
      writeFileSync(file, wav);
      const out = resample(await readWav(file), 48000);
      assert.equal(out.samples.length, 4800);
      assert.ok(out.samples.every((sample) => sample === 0.25));
      if (bytes === 4) wav.writeFloatLE(NaN, 44);
      else wav.writeDoubleLE(Infinity, 44);
      writeFileSync(file, wav);
      await assert.rejects(readWav(file), /non-finite WAV sample/);
    }
  }
});
