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
  const previous = "previous output";
  writeFileSync(custom, previous);
  for (const [args, message] of [
    [[input, "--at", "1"], /video duration \(1 s\)/],
    [[input, "--at=-1"], /nonnegative/],
    [[input, "--at", "abc"], /--at must be a number/],
    [[input, "--sheet"], /--sheet does not apply/],
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
