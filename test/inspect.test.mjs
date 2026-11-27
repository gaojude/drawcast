import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findFfmpeg } from "../src/render/encode.ts";
import { inspectVideo } from "../src/render/inspect.ts";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const run = (...args) => spawnSync(process.execPath, [cli, "inspect", ...args], { encoding: "utf8" });

test("inspect samples the encoded video in display order and extracts the frame visible at --at", async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return t.skip("requires ffmpeg");
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-inspect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "lesson 1.mp4");
  // Ten progressively brighter frames with B-frame reordering.
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "nullsrc=s=32x24:r=10:d=1,geq=lum=24+20*N:cb=128:cr=128", "-c:v", "libx264", "-bf", "2", "-video_track_timescale", "90000", input]);
  const pixels = (file, filter) => execFileSync(ffmpeg, ["-v", "error", "-i", file, ...(filter ? ["-vf", filter] : []), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const expected = pixels(input, "crop=2:2:16:12");
  const sheet = run(input);
  assert.equal(sheet.status, 0, sheet.stderr);
  assert.match(sheet.stdout, /1 s, 32x24, 10 frames, 10 fps average, no audio track/);
  assert.match(sheet.stdout, /lesson 1\.inspect\.png .*0, 0\.2, 0\.4, 0\.5, 0\.7, 0\.9 s/);
  const sheetFile = path.join(dir, "lesson 1.inspect.png");
  const indices = [0, 2, 4, 5, 7, 9];
  for (const [i, n] of indices.entries()) {
    const x = 4 + (i % 3) * 516 + 256;
    const y = 4 + Math.floor(i / 3) * 388 + 192;
    assert.ok(Math.abs(pixels(sheetFile, `crop=2:2:${x}:${y}`)[0] - expected[n * 12]) <= 1, `tile ${i + 1}`);
  }
  for (const [at, frame] of [[0.7, 7], [0.9999, 9]]) {
    const snap = run(input, "--at", String(at));
    assert.equal(snap.status, 0, snap.stderr);
    const png = path.join(dir, `lesson 1.inspect.at${at}.png`);
    assert.deepEqual(pixels(png, "crop=2:2:16:12"), expected.subarray(frame * 12, (frame + 1) * 12));
    assert.equal(readFileSync(png).readUInt32BE(16), 32);
  }
  const custom = path.join(dir, "custom.png");
  const batch = run(input, "--at", "0.7,0.21,0.22");
  assert.equal(batch.status, 0, batch.stderr);
  assert.match(batch.stdout, /lesson 1\.inspect\.times\.png .*0\.2, 0\.7 s/);
  const batchFile = path.join(dir, "lesson 1.inspect.times.png");
  assert.equal(readFileSync(batchFile).readUInt32BE(16), 1036);
  for (const [column, frame] of [2, 7].entries()) {
    assert.ok(Math.abs(pixels(batchFile, `crop=2:2:${260 + 516 * column}:196`)[0] - expected[frame * 12]) <= 1);
  }
  for (const [at, width] of [["0.2,0.7", 140], ["0.2", 64]]) {
    const resized = run(input, "--at", at, "--width", "64", "-o", custom);
    assert.equal(resized.status, 0, resized.stderr);
    assert.equal(readFileSync(custom).readUInt32BE(16), width);
  }
  const previous = "previous output";
  writeFileSync(custom, previous);
  for (const [args, message] of [
    [[input, "--at", "1"], /video duration \(1 s\)/],
    [[input, "--at=-1"], /nonnegative/],
    [[input, "--at", "abc"], /--at must be a number/],
    [[input, "--at", "0.3", "--motion"], /Choose --motion/],
    [[input, "--at", "0.1,1.1"], /video duration/],
    [[input, "--at", "0.1,,0.3"], /--at must be a number/],
    [[input, "--at", Array(13).fill("0").join(",")], /twelve times/],
    [[input, "--sheet"], /--sheet does not apply/],
    [[input, "--width", "0"], /positive integer/],
    [[custom], /Could not inspect/],
  ]) {
    const failure = run(...args, "-o", args[0] === custom ? sheetFile : custom);
    assert.equal(failure.status, 1, failure.stdout);
    assert.match(failure.stderr, message);
    assert.equal(readFileSync(custom, "utf8"), previous);
  }
  const original = readFileSync(input);
  assert.match(run(input, "-o", input).stderr, /different from the input MP4/);
  assert.deepEqual(readFileSync(input), original);

  const controller = new AbortController();
  const watcher = watch(dir, (_event, name) => { if (name?.startsWith(".drawcast-")) controller.abort(); });
  try {
    await assert.rejects(inspectVideo(input, custom, undefined, controller.signal), { name: "AbortError" });
  } finally {
    watcher.close();
  }
  assert.equal(readFileSync(custom, "utf8"), previous);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".drawcast-")), []);
  const replaced = run(input, "--at", "0", "-o", custom);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(readFileSync(custom).toString("ascii", 1, 4), "PNG");
});

test("motion inspection finds two brief changes between long holds", async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return t.skip("requires ffmpeg");
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-motion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, "two moves.mp4");
  const pattern = "nullsrc=s=48x32:r=10:d=10,geq=lum='40+20*clip(N-20,0,4)+20*clip(N-73,0,4)':cb=128:cr=128";
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", pattern, "-c:v", "libx264", video]);
  const sheet = run(video, "--motion");
  assert.equal(sheet.status, 0, sheet.stderr);
  assert.match(sheet.stdout, /two moves\.inspect\.motion\.png/);
  const times = sheet.stdout.match(/encoded frames at ([\d., ]+) s/)[1].split(", ").map(Number);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 9.9);
  assert.ok(times.some(t => t > 2 && t <= 2.4), times);
  assert.ok(times.some(t => t > 7.3 && t <= 7.7), times);
});
