import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordInBrowser } from "../src/render/render.ts";
import { findFfmpeg } from "../src/render/encode.ts";
import { avcCodecs, colorTags, segmentFrames } from "../src/shared/h264.ts";

test("the encoder is asked for the lowest H.264 level that holds the video", () => {
  assert.deepEqual(avcCodecs(1920, 1080, 30), ["avc1.640028", "avc1.42e028"]);
  assert.deepEqual(avcCodecs(1920, 1080, 60), ["avc1.64002a", "avc1.42e02a"]);
  assert.deepEqual(avcCodecs(1280, 720, 30), ["avc1.64001f", "avc1.42e01f"]);
  assert.deepEqual(avcCodecs(3840, 2160, 30), ["avc1.640033", "avc1.42e033"]);
  assert.deepEqual(avcCodecs(3840, 2160, 60), ["avc1.640034", "avc1.42e034"]);
  assert.deepEqual(avcCodecs(4096, 64, 30), ["avc1.640028", "avc1.42e028"]);
});

test("a video H.264 cannot hold gets no encoder", () => {
  assert.deepEqual(avcCodecs(1921, 1080, 30), []);
  assert.deepEqual(avcCodecs(7680, 4320, 30), []);
  assert.deepEqual(avcCodecs(3840, 2160, 120), []);
  assert.deepEqual(avcCodecs(64, 10000, 1), []);
  assert.deepEqual(avcCodecs(0, 100, 30), []);
  assert.deepEqual(avcCodecs(100, 100, -1), []);
});

test("the stream is labelled with the colour space the encoder says it used", () => {
  assert.equal(colorTags({ fullRange: false, matrix: "bt709", primaries: "bt709", transfer: "iec61966-2-1" }), "video_full_range_flag=0:colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1");
  assert.equal(colorTags({ fullRange: true, matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m" }), "video_full_range_flag=1:colour_primaries=6:transfer_characteristics=6:matrix_coefficients=6");
  // what the encoder leaves out, or names in a way H.264 has no number for, is left alone
  assert.equal(colorTags({ fullRange: null, matrix: "bt709", primaries: null, transfer: "something-new" }), "matrix_coefficients=1");
  assert.equal(colorTags({}), null);
  assert.equal(colorTags(null), null);
});

test("segments are a second to five seconds long, and several per encoder", () => {
  assert.equal(segmentFrames(9000, 30, 2), 150);
  assert.equal(segmentFrames(684, 30, 2), 114);
  assert.equal(segmentFrames(100, 30, 2), 30);
  assert.equal(segmentFrames(1200, 60, 1), 300);
  assert.equal(segmentFrames(1, 30, 2), 30);
});

test("a rejected browser stream leaves the page open for the ffmpeg fallback", async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return t.skip("requires ffmpeg");
  const previous = process.env.DRAWCAST_ENCODER;
  delete process.env.DRAWCAST_ENCODER;
  t.after(() => { if (previous !== undefined) process.env.DRAWCAST_ENCODER = previous; });
  const dir = mkdtempSync(path.join(tmpdir(), "drawcast-mux-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let stops = 0;
  let segment = Buffer.alloc(0);
  const player = {
    encoder: async () => ({ encoder: { lanes: 1, color: null }, tried: [] }),
    encodeSegment: async () => segment,
    stopEncoding: async () => { stops++; },
    close: () => assert.fail("closed the page before fallback"),
  };
  const options = { output: path.join(dir, "out.mp4"), fps: 1, frames: 1, cover: null, audio: path.join(dir, "audio.pcm"), pcmRate: 48000, log: () => {} };
  writeFileSync(options.audio, Buffer.alloc(96000));
  assert.equal(await recordInBrowser(player, options), false);
  // Give ffmpeg a complete video and audio, then make opening the output file fail.
  segment = execFileSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", "color=s=16x16:r=1", "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "pipe:1"]);
  assert.equal(await recordInBrowser(player, { ...options, output: path.join(dir, "absent", "out.mp4") }), false);
  assert.equal(stops, 2);
});
