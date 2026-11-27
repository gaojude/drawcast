import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { findBrowser } from "../src/render/browser.ts";
import { findFfmpeg } from "../src/render/encode.ts";
import { loadScript, parseSteps, renderSnapshot } from "../src/render/render.ts";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const sample = path.resolve(import.meta.dirname, "../examples/cache.drawcast.json");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("snapshot ranges reject empty, reversed, malformed and out-of-bounds selections", () => {
  for (const value of ["", "2-1", "1-2-3", "0", "2-", "-1", "1,,3", "1-999999999999"]) {
    assert.throws(() => parseSteps(value, 3), /--step/, value);
  }
  assert.deepEqual(parseSteps("2, 1-3", 3), [2, 1, 3]);
});

test("a UTF-8 byte order mark is accepted at the start of a script", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "script.json");
  writeFileSync(file, '\uFEFF{"drawcast":1,"steps":[{"duration":1}]}');
  assert.deepEqual((await loadScript(file)).report.errors, []);
});

test("invalid options fail with a diagnostic before a render starts", () => {
  for (const [command, args, error] of [
    ["snapshot", ["--width", "0"], /--width/],
    ["render", ["--fps", "0"], /--fps/],
    ["render", ["--speed", "3"], /--speed/],
    ["snapshot", ["--at", "1", "--sheet"], /--at/],
    ["snapshot", ["--voice", "unavailable-example"], /no voice/i],
    ["render", ["--voice", " "], /--voice/],
    ["render", ["--step", "1"], /--step/],
    ["snapshot", ["-o", sample], /input script/],
  ]) {
    const result = run(command, sample, ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stderr, /Narration\n/);
  }
});

test("a generated snapshot name cannot overwrite an image used by the script", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "script.json");
  const image = "picture-step2.png";
  writeFileSync(path.join(dir, image), "original asset");
  writeFileSync(file, JSON.stringify({ drawcast: 1, steps: [{ do: [{ add: { id: "pic", type: "image", src: image, x: 0, y: 0 } }] }, { duration: 1 }] }));
  const loaded = await loadScript(file);
  await assert.rejects(renderSnapshot(loaded, { output: path.join(dir, "picture.png"), steps: [1, 2], log() {} }), /input script and its images/);
  assert.equal(readFileSync(path.join(dir, image), "utf8"), "original asset");
  assert.equal(existsSync(path.join(dir, "picture-step1.png")), false);
});

test("snapshots size and move inline SVG alongside a file with the same name as its id", async (t) => {
  if (!existsSync(path.join(import.meta.dirname, "../dist/player/index.html"))) return t.skip("requires the built player");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || !await findBrowser(false, () => {})) return t.skip("requires a browser and ffmpeg");
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-inline-svg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="${fill}"/></svg>`;
  writeFileSync(path.join(dir, "book.svg"), svg("blue"));
  const file = path.join(dir, "script.json");
  writeFileSync(file, JSON.stringify({ drawcast: 1, canvas: { width: 160, height: 100 }, captions: false, steps: [
    { do: [{ enter: "none", add: [
      { type: "image", id: "book.svg", svg: svg("red"), x: 10, y: 10, height: 20 },
      { type: "image", id: "file", src: "book.svg", x: 100, y: 10 },
    ] }] },
    { do: [{ update: { id: "book.svg", dx: 50, dy: 25 } }] },
  ] }));
  const loaded = await loadScript(file);
  assert.deepEqual(loaded.report, { errors: [], warnings: [] });
  const { files } = await renderSnapshot(loaded, { output: path.join(dir, "shot.png"), steps: [1, 2], log() {} });
  const [before, after] = files.map(({ file }) => execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]));
  const pixel = (frame, x, y) => frame.readUIntBE((160 * y + x) * 3, 3);
  assert.deepEqual([pixel(before, 48, 28), pixel(after, 48, 28)], [0xff0000, 0xffffff]);
  assert.deepEqual([pixel(before, 98, 53), pixel(after, 98, 53)], [0xffffff, 0xff0000]);
  assert.deepEqual([pixel(before, 110, 15), pixel(after, 110, 15)], [0x0000ff, 0x0000ff]);
});

test("an invalid encoder is reported before any narration is requested", () => {
  const result = spawnSync(process.execPath, [cli, "render", sample, "--voice", "maple"], {
    encoding: "utf8", env: { ...process.env, DRAWCAST_FFMPEG: path.join(os.tmpdir(), "drawcast-missing-encoder-test.exe") },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DRAWCAST_FFMPEG/);
  assert.doesNotMatch(result.stderr, /Narration|speaking/);
});

test("even a silent render reports elapsed speech and encoding time", async (t) => {
  if (!existsSync(path.join(import.meta.dirname, "../dist/player/index.html"))) return t.skip("requires the built player");
  const browser = await findBrowser(false, () => {});
  if (!browser || !findFfmpeg()) return t.skip("requires a browser and ffmpeg");
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-timings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "silent.json");
  writeFileSync(file, JSON.stringify({ drawcast: 1, steps: [{ duration: 1 }] }));
  for (const encoder of ["browser", "ffmpeg"]) {
    const result = spawnSync(process.execPath, [cli, "render", file, "--width", "160", "--fps", "2"], {
      encoding: "utf8", env: { ...process.env, DRAWCAST_BROWSER: browser, DRAWCAST_ENCODER: encoder }, timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const total = /rendered in (\d+\.\d{3}) s/.exec(result.stdout);
    const phases = /Phase wall times \(may overlap\): speech preparation and synthesis (\d+\.\d{3}) s, video encoding and MP4 muxing (\d+\.\d{3}) s/.exec(result.stderr);
    assert.ok(total, result.stdout);
    assert.ok(phases, result.stderr);
    assert.ok(Number(phases[1]) <= Number(total[1]), result.stdout);
    assert.ok(Number(phases[2]) > 0 && Number(phases[2]) <= Number(total[1]), result.stdout);
  }
});

test("interrupting a render stops the voice, preserves the previous MP4 and cleans up", { timeout: 20000 }, async (t) => {
  const browser = await findBrowser(false, () => {});
  if (!browser) return t.skip("requires an installed browser");
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-interrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "video.mp4");
  const pidFile = path.join(dir, "voice.pid");
  const helper = path.join(dir, "voice.cjs");
  writeFileSync(output, "previous video");
  writeFileSync(helper, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 10000);');
  // Node cannot send Unix signals to Windows children. Deliver the same event over IPC there.
  const windows = process.platform === "win32";
  const preload = 'data:text/javascript,' + encodeURIComponent('process.once("message", (name) => { process.emit(name, name); process.disconnect(); });');
  const voiceCommand = `"${process.execPath}" "${helper}" "${pidFile}"`;
  const child = spawn(process.execPath, [...(windows ? ["--import", preload] : []), cli, "render", sample, "--tts-command", voiceCommand, "-o", output], {
    env: { ...process.env, DRAWCAST_HOME: dir, DRAWCAST_BROWSER: browser }, stdio: ["ignore", "ignore", "pipe", ...(windows ? ["ipc"] : [])],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const deadline = Date.now() + 10000;
  while (!existsSync(pidFile) && child.exitCode === null && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(pidFile), stderr);
  if (windows) child.send("SIGINT");
  else child.kill("SIGINT");
  assert.equal(await ended, 130, stderr);
  assert.match(stderr, /Interrupted by SIGINT/);
  assert.equal(readFileSync(output, "utf8"), "previous video");
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".drawcast-")), []);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
});

test("SIGTERM interrupts model setup and snapshots without publishing staged files", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-sigterm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stop = 'const stop = () => process.platform === "win32" ? process.emit("SIGTERM", "SIGTERM") : process.kill(process.pid, "SIGTERM");';
  const output = path.join(dir, "existing.png");
  writeFileSync(output, "previous snapshot");
  // Keep a real transfer in flight while POSIX delivers SIGTERM on a later event-loop turn.
  const download = `
    import { createServer } from "node:http";
    const server = createServer((_req, res) => {
      res.write("partial model");
      server.close();
      setImmediate(stop);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const fetchModel = globalThis.fetch;
    globalThis.fetch = (_url, options) => fetchModel("http://127.0.0.1:" + server.address().port, options);
  `;
  const commands = [
    { args: ["setup"], hook: download },
    { args: ["snapshot", sample, "-o", output], hook: 'import {watch} from "node:fs"; const w = watch(process.env.DRAWCAST_HOME, {persistent: false}, (_event, file) => { if (file?.startsWith(".drawcast-")) { w.close(); stop(); } });' },
  ];
  for (const { args, hook } of commands) {
    const preload = "data:text/javascript," + encodeURIComponent(stop + hook);
    const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", env: { ...process.env, DRAWCAST_HOME: dir } });
    assert.ifError(result.error);
    assert.equal(result.status, 143, result.stderr);
    assert.match(result.stderr, /Interrupted by SIGTERM/);
  }
  assert.deepEqual(readdirSync(path.join(dir, "models")), []);
  assert.equal(readFileSync(output, "utf8"), "previous snapshot");
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".drawcast-")), []);
});
