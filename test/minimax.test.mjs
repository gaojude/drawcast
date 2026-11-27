import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RETRY_WAITS, minimaxKey, minimaxKeyStatus, openMinimaxVoice, parseMinimaxVoice, removeMinimaxKey, saveMinimaxKey } from "../src/voice/minimax.ts";
import { resolveVoice } from "../src/voice/voice.ts";

const KEY = "sk-api-test-0123456789abcdef-WXYZ";
const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

/** A drawcast home of its own, and no key or host from the environment that runs the tests. */
function isolated(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-minimax-"));
  const saved = Object.fromEntries(["DRAWCAST_HOME", "MINIMAX_API_KEY", "MINIMAX_API_HOST"].map((name) => [name, process.env[name]]));
  process.env.DRAWCAST_HOME = dir;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_HOST;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The hex of 16-bit PCM for these sample values, as the API returns it. */
const hexPcm = (...values) => {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf.toString("hex");
};
const reply = (code, msg, audio) => new Response(JSON.stringify({ base_resp: { status_code: code, status_msg: msg }, data: audio === undefined ? null : { audio } }));

test("a MiniMax voice is named by its voice id, with the model after an @", async () => {
  const resolve = (spec) => resolveVoice({ spec, narration: "你好。", log: () => {} });
  const hd = await resolve("minimax:hunyin_6");
  assert.equal(hd.name, "minimax:hunyin_6");
  // a paid voice is never a stand-in for another
  assert.equal(hd.fallback, undefined);
  assert.equal(hd.key, (await resolve("minimax:hunyin_6@speech-2.8-hd")).key);
  assert.notEqual(hd.key, (await resolve("minimax:hunyin_6@speech-2.8-turbo")).key);
  assert.notEqual(hd.key, (await resolve("minimax:male-qn-qingse")).key);
  assert.deepEqual(parseMinimaxVoice(" male-qn-qingse @ speech-2.8-turbo "), { voiceId: "male-qn-qingse", model: "speech-2.8-turbo" });
  for (const bad of ["minimax:", "minimax:x@", "minimax:x@a@b", "minimax:@speech-2.8-hd"]) {
    await assert.rejects(resolve(bad), /is not a MiniMax voice/, bad);
  }
});

test("the key comes from MINIMAX_API_KEY or the saved file, and is never shown whole", async (t) => {
  const dir = isolated(t);
  assert.equal(minimaxKey(), null);
  assert.match(minimaxKeyStatus(), /drawcast key minimax/);

  const file = await saveMinimaxKey(KEY);
  assert.equal(path.dirname(file), dir);
  assert.deepEqual(minimaxKey(), { key: KEY, source: file });
  assert.match(minimaxKeyStatus(), /ending WXYZ/);
  assert.doesNotMatch(minimaxKeyStatus(), /0123456789/);

  process.env.MINIMAX_API_KEY = "sk-from-env-1234";
  assert.deepEqual(minimaxKey(), { key: "sk-from-env-1234", source: "MINIMAX_API_KEY" });
  delete process.env.MINIMAX_API_KEY;

  await removeMinimaxKey();
  assert.equal(existsSync(file), false);
  assert.equal(minimaxKey(), null);
});

test("without a key, a MiniMax voice says how to give it one without pasting it anywhere", async (t) => {
  isolated(t);
  await assert.rejects(openMinimaxVoice({ voiceId: "hunyin_6", model: "speech-2.8-hd" }, () => {}), /drawcast key minimax.*Never put the key in the script/s);
});

test("a key the international platform refuses is tried in mainland China, and that address is kept", async (t) => {
  isolated(t);
  process.env.MINIMAX_API_KEY = KEY;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return url.includes("api.minimax.io") ? reply(2049, "invalid api key") : reply(0, "success", hexPcm(0, 16384, -32768));
  });
  const logs = [];
  const say = await openMinimaxVoice({ voiceId: "hunyin_6", model: "speech-2.8-hd" }, (line) => logs.push(line));
  const audio = await say("你好。");
  assert.equal(audio.sampleRate, 32000);
  assert.deepEqual([...audio.samples], [0, 0.5, -1]);
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ["api.minimax.io", "api.minimaxi.com"]);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[1].body.voice_setting, { voice_id: "hunyin_6", speed: 1, vol: 1, pitch: 0 });
  assert.equal(calls[1].body.model, "speech-2.8-hd");
  assert.equal(calls[1].body.text, "你好。");
  assert.equal(calls[1].body.audio_setting.format, "pcm");
  assert.match(logs.join("\n"), /api\.minimaxi\.com/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(KEY));

  // the next sentences go straight to the address that took the key, even when asked for at once
  await Promise.all([say("一。"), say("二。")]);
  assert.deepEqual(calls.slice(2).map((c) => new URL(c.url).host), ["api.minimaxi.com", "api.minimaxi.com"]);
});

test("the first sentences wait for the address instead of each trying every platform", async (t) => {
  isolated(t);
  process.env.MINIMAX_API_KEY = KEY;
  const hosts = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    hosts.push(new URL(url).host);
    return url.includes("api.minimax.io") ? reply(1004, "authentication failed") : reply(0, "success", hexPcm(1));
  });
  const say = await openMinimaxVoice({ voiceId: "v", model: "m" }, () => {});
  await Promise.all([say("a."), say("b."), say("c.")]);
  assert.deepEqual(hosts, ["api.minimax.io", "api.minimaxi.com", "api.minimaxi.com", "api.minimaxi.com"]);
});

test("MINIMAX_API_HOST goes straight to one platform", async (t) => {
  isolated(t);
  process.env.MINIMAX_API_KEY = KEY;
  process.env.MINIMAX_API_HOST = "https://api.minimaxi.com/";
  const hosts = [];
  t.mock.method(globalThis, "fetch", async (url) => (hosts.push(new URL(url).host), reply(2049, "invalid api key")));
  const say = await openMinimaxVoice({ voiceId: "v", model: "m" }, () => {});
  await assert.rejects(say("a."), /did not accept the API key \(MINIMAX_API_KEY\) at api\.minimaxi\.com/);
  assert.deepEqual(hosts, ["api.minimaxi.com"]);
});

test("MiniMax's refusals become messages that say what to do", async (t) => {
  isolated(t);
  process.env.MINIMAX_API_KEY = KEY;
  for (const [code, msg, expected] of [
    [2049, "invalid api key", /did not accept the API key .* api\.minimax\.io or api\.minimaxi\.com/],
    [1008, "insufficient balance", /run out of balance.*not paid for twice/],
    [2054, "voice id not exist", /no voice "hunyin_6"/],
    [2013, "invalid params", /refused the request for minimax:hunyin_6 with the model speech-2\.8-hd/],
  ]) {
    t.mock.method(globalThis, "fetch", async () => reply(code, msg));
    const say = await openMinimaxVoice({ voiceId: "hunyin_6", model: "speech-2.8-hd" }, () => {});
    await assert.rejects(say("你好。"), (e) => expected.test(e.message) && !e.message.includes(KEY), String(code));
    t.mock.restoreAll();
  }
});

test("a rate limit is waited out, said once, and the sentence asked for again", async (t) => {
  isolated(t);
  process.env.MINIMAX_API_KEY = KEY;
  const waits = { ...RETRY_WAITS };
  RETRY_WAITS.rateLimit = [1, 1, 1];
  RETRY_WAITS.transient = [1];
  t.after(() => Object.assign(RETRY_WAITS, waits));

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => (++calls <= 2 ? reply(1002, "rate limit exceeded(RPM)") : reply(0, "success", hexPcm(8192))));
  const logs = [];
  const say = await openMinimaxVoice({ voiceId: "v", model: "m" }, (line) => logs.push(line));
  assert.deepEqual([...(await say("a.")).samples], [0.25]);
  assert.equal(calls, 3);
  assert.equal(logs.filter((line) => /rate limit/.test(line)).length, 1);

  // a limit that does not lift is given up on once the waits are used up
  t.mock.method(globalThis, "fetch", async () => new Response("busy", { status: 429 }));
  await assert.rejects(say("b."), /could not say "b\."/);
});

test("drawcast key minimax saves a piped key, shows only its end, and removes it", (t) => {
  const dir = isolated(t);
  const env = { ...process.env, DRAWCAST_HOME: dir };
  const saved = spawnSync(process.execPath, [cli, "key", "minimax"], { input: `${KEY}\n`, encoding: "utf8", env });
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /ending WXYZ/);
  assert.doesNotMatch(saved.stdout + saved.stderr, /0123456789/);
  assert.equal(readFileSync(path.join(dir, "minimax-api-key"), "utf8").trim(), KEY);

  const voices = spawnSync(process.execPath, [cli, "voices"], { encoding: "utf8", env });
  assert.match(voices.stdout, /minimax: API key ending WXYZ, saved in/);
  assert.match(voices.stdout, /minimax:male-qn-qingse/);

  for (const [args, input, error] of [[["key", "openai"], "", /only service/], [["key", "minimax"], "", /No key/], [["key", "minimax"], "two words\n", /spaces/]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", env });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, error);
  }
  // a refused key leaves the saved one alone
  assert.equal(readFileSync(path.join(dir, "minimax-api-key"), "utf8").trim(), KEY);

  const removed = spawnSync(process.execPath, [cli, "key", "minimax", "--remove"], { encoding: "utf8", env });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(path.join(dir, "minimax-api-key")), false);
});
