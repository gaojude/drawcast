import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findBrowser } from "../src/render/browser.ts";
import { findFfmpeg } from "../src/render/encode.ts";
import { importNarration, narrationRequest } from "../src/narration/manifest.ts";
import { writeWav } from "../src/narration/wav.ts";

const script = { drawcast: 1, steps: [
  { say: "Open up the window. Look at the river.", do: [{ at: "river", add: { id: "label", type: "text", text: "River", x: 25, y: 30 } }] },
  { duration: 0.3 },
  { say: "Close up the window." },
] };
const entries = [
  { id: "s1.1", audio: "take.wav", startMs: 100, endMs: 350 },
  { id: "s1.2", audio: "take.wav", startMs: 450, endMs: 800, tokenStartsMs: [450, 500, 600, 750] },
  { id: "s3.1", audio: "take.wav" },
];

async function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-external-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "result.json");
  const request = narrationRequest(script);
  const save = (sentences) => writeFileSync(file, JSON.stringify({ version: 1, fingerprint: request.fingerprint, sentences }));
  save(entries.toReversed());
  const sampleRate = 16000;
  await writeWav(path.join(dir, "take.wav"), { sampleRate, samples: Float32Array.from({ length: sampleRate }, (_, i) => Math.sin(i / 6) * 0.6) });
  return { dir, file, request, save };
}

test("shared takes retain audio between sentences and place imported tokens on the step clock", async (t) => {
  const { file, save } = await fixture(t);
  const { steps, clips } = await importNarration(script, file, true);
  assert.deepEqual((await importNarration(script, file, false)).steps, steps);
  assert.deepEqual(steps.map(s => s?.duration), [0.7, undefined, 1]);
  assert.equal(clips[0].samples.length, 33600);
  assert.ok(clips[0].samples.subarray(12000, 16800).some(sample => sample > 0.5));
  assert.deepEqual(steps[0].tokens.at(-1), { token: "river", t: 0.65 });
  assert.deepEqual(steps[0].captions.map(({ t0, t1 }) => [t0, t1]), [[0, 0.25], [0.35, 0.7]]);
  save(entries.map(({ id, audio }) => ({ id, audio })));
  const split = await importNarration(script, file, true);
  assert.equal(split.steps[0].duration, 2.28);
  assert.ok(split.clips[0].samples.subarray(48000, 61440).every(sample => sample === 0));
});

test("fingerprint follows spoken text and step grouping; malformed results identify the problem", async (t) => {
  const { file, save, request } = await fixture(t);
  assert.equal(narrationRequest({ steps: script.steps.map(({ say }) => ({ say, pause: 2 })) }).fingerprint, request.fingerprint);
  await assert.rejects(importNarration({ steps: [{ say: "Changed." }] }, file, false), /fingerprint/);
  for (const [sentences, error] of [
    [entries.slice(1), /Missing narration for s1.1/],
    [[...entries, entries[1]], /duplicate.*s1.2/],
    [[{ ...entries[0], id: "extra" }], /Unknown.*extra/],
    [[{ ...entries[0], endMs: 1500 }, ...entries.slice(1)], /s1.1.*inside/],
    [[{ ...entries[0], endMs: undefined }, ...entries.slice(1)], /s1.1.endMs/],
    [[entries[0], { ...entries[1], startMs: 300 }, entries[2]], /s1.2 overlaps/],
    [[entries[0], { ...entries[1], tokenStartsMs: [450] }, entries[2]], /per exported token/],
    [[entries[0], { ...entries[1], tokenStartsMs: [450, 500, 490, 750] }, entries[2]], /ordered/],
  ]) {
    save(sentences);
    await assert.rejects(importNarration(script, file, false), error);
  }
});

test("built CLI exports a request, renders imported audio and previews the same timeline", async (t) => {
  const cli = path.resolve(import.meta.dirname, "../dist/cli.js");
  const ffmpeg = findFfmpeg();
  if (!existsSync(cli) || !ffmpeg || !await findBrowser(false, () => {})) return t.skip("requires built CLI, browser and ffmpeg");
  const { dir, file, request } = await fixture(t);
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(path.join(dir, "talk.json"), JSON.stringify(script));
  run("narration", "export", "talk.json", "-o", "request.json");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "request.json"))), request);
  assert.throws(() => run("render", "talk.json", "--narration", file, "-o", "take.wav"), /output different/);
  run("render", "talk.json", "--narration", file, "--width", "256", "--fps", "8");
  const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", path.join(dir, "talk.mp4"), "-map", "0:a:0", "-f", "s16le", "-"]);
  const peak = (seconds) => {
    const at = Math.round(seconds * 48000);
    let value = 0;
    for (let i = at; i < at + 480; i++) value = Math.max(value, Math.abs(pcm.readInt16LE(i * 2)));
    return value;
  };
  assert.ok(peak(0.2) < 10, "silent lead-in");
  assert.ok(peak(0.6) > 1000, "first recorded step");
  assert.ok(peak(1.4) < 10, "silence after the first recording");
  assert.ok(peak(2.1) > 1000, "recording after the silent step");
  assert.match(run("snapshot", "talk.json", "--narration", file, "--at", "0.65", "--width", "256"), /timing from imported narration/);
  assert.ok(existsSync(path.join(dir, "talk.at0.65.png")));
});
