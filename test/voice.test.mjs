import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guess } from "../src/voice/guess.ts";
import { ensureModels, modelsDir, modelsInstalled } from "../src/voice/models.ts";
import { cachedNarration, narrate } from "../src/voice/narrate.ts";
import { normalize } from "../src/voice/normalize.ts";
import { parseDictionary, toTokens } from "../src/voice/tokenize.ts";
import { mixSpeakers, resolveVoice, speechTokens, tokenBatches } from "../src/voice/voice.ts";
import { changeTempo, encodeWav, readWav, resample, trimSilence } from "../src/voice/wav.ts";

// a dictionary that knows every word but these, and "pronounces" a word as itself
const UNKNOWN = new Set(["running", "runn", "bak", "codebase", "codebase's", "readme", "baked", "github", "xkcd", "kafka", "kaf"]);
const lexicon = { get: (word) => (UNKNOWN.has(word) ? undefined : word) };
const say = (text) => normalize(text, lexicon).text;

test("numbers are read out in the language of the sentence", () => {
  assert.equal(say("it costs 1,250 more"), "it costs one thousand two hundred fifty more");
  assert.equal(say("it costs 3.5% more"), "it costs three point five percent more");
  assert.equal(say("in 1987"), "in nineteen eighty seven");
  assert.equal(say("in 2005"), "in two thousand five");
  assert.equal(say("共1087个"), "共一千零八十七个");
  assert.equal(say("增长了12.5%"), "增长了百分之十二点五");
  assert.equal(say("2023年"), "二零二三年");
  assert.equal(say("有12个"), "有十二个");
  assert.equal(say("in 1900"), "in nineteen hundred");
  assert.equal(say("-5 degrees"), "minus five degrees");
  assert.equal(say("共100001001个"), "共一亿零一千零一个");
  assert.equal(say("共1000000000000个"), "共一万亿个");
});

test("short acronyms are spelled, known words in capitals are read", () => {
  assert.equal(say("the API is OK"), "the ltra ltrp ltri is ltro ltrk");
  assert.equal(say("NASA"), "nasa");
});

test("full-width numbers, decimals, accents and mathematical operators reach the built-in voice", () => {
  assert.equal(say("增长了１２．５％"), "增长了百分之十二点五");
  assert.equal(say("the café costs .75"), "the cafe costs zero point seven five");
  assert.equal(say("4−2"), "four minus two");
  assert.equal(say("3×4÷2"), "three times four divided by two");
  assert.equal(say("APIClient"), "ltra ltrp ltri client");
});

test("a guessed name cannot change the pronunciation of another sentence", () => {
  const dict = { english: parseDictionary("ltrk k\nltra a\nltrf f"), chinese: new Map() };
  const acronym = speechTokens("KAFKA", dict);
  assert.notDeepEqual(speechTokens("Kafka", dict), acronym);
  assert.deepEqual(speechTokens("KAFKA", dict), acronym);
  assert.equal(dict.english.has("kafka"), false);
});

test("an unknown word is built from known ones, read by its spelling, or spelled out", () => {
  const out = normalize("running the codebase's README on GitHub, baked by xkcd for Kafka", lexicon);
  assert.equal(out.text, "running the codebase's readme on git hub, baked by ltrx ltrk ltrc ltrd for kafka");
  assert.equal(out.entries.get("running"), "run ɪ ŋ");
  assert.equal(out.entries.get("baked"), "bake d");
  assert.equal(out.entries.get("readme"), "read me");
  assert.equal(out.entries.get("kafka"), "k ˈ æ f k ə");
});

test("an ending takes its sound from the one before it", () => {
  const words = new Map([["narrate", "n ˈ ɛ ɹ ˌ A t"], ["bake", "b ˈ A k"], ["play", "p l ˈ A"], ["box", "b ˈ ɑ k s"]]);
  const { entries } = normalize("narrated, baked, played, boxes, bakes, plays", { get: (word) => words.get(word) });
  assert.equal(entries.get("narrated"), "n ˈ ɛ ɹ ˌ A t ᵻ d");
  assert.equal(entries.get("baked"), "b ˈ A k t");
  assert.equal(entries.get("played"), "p l ˈ A d");
  assert.equal(entries.get("boxes"), "b ˈ ɑ k s ᵻ z");
  assert.equal(entries.get("bakes"), "b ˈ A k s");
  assert.equal(entries.get("plays"), "p l ˈ A z");
});

test("spelling rules give a recognisable reading", () => {
  const read = (word) => guess(word)?.replaceAll(" ", "");
  assert.equal(read("redis"), "ɹˈɛdɪs");
  assert.equal(read("ubuntu"), "ubˈʌntu");
  assert.equal(read("vite"), "vˈIt");
  assert.equal(read("tokio"), "tˈOkiO");
  assert.equal(read("vercel"), "vˈɜɹsɛl");
  assert.equal(read("grpc"), undefined);
});

test("tokens put a space around English words and none inside Chinese", () => {
  const dict = {
    english: parseDictionary("it ɪ t\nasks æ s k s\nreact ɹ i ˈ æ k t\nthe ð ə\narrow ˈ ɛ ɹ O\nserver s ˈ ɜ ɹ v ə ɹ"),
    chinese: parseDictionary("银 阴 2\n行 ㄒ 应 2\n银行 阴 2 ㄏ ㄤ 2\n用 用 4"),
  };
  assert.deepEqual(toTokens("It asks.", dict), ["ɪ", "t", " ", "æ", "s", "k", "s", "."]);
  assert.deepEqual(toTokens("银行用 react，行", dict), ["阴", "2", "ㄏ", "ㄤ", "2", "用", "4", " ", "ɹ", "i", "ˈ", "æ", "k", "t", ",", "ㄒ", "应", "2"]);
  assert.deepEqual(toTokens("react用", dict), ["ɹ", "i", "ˈ", "æ", "k", "t", " ", "用", "4"]);
  // a word the dictionary lacks is left out, which is why normalize() gives every word an entry first
  assert.deepEqual(toTokens("it plugh asks", dict), ["ɪ", "t", " ", "æ", "s", "k", "s"]);
  // "the" is "thee" before a vowel
  assert.equal(toTokens("the arrow, the server", dict).join(""), "ði ˈɛɹO, ðə sˈɜɹvəɹ");
});

test("tones change inside a word as they do in speech", () => {
  const chinese = parseDictionary("所 ㄙ 我 3\n以 ㄧ 3\n我 我 3\n一 ㄧ 1\n下 ㄒ 压 4\n百 ㄅ ㄞ 3\n月 月 4\n不 ㄅ ㄨ 4\n对 ㄉ 为 4\n行 ㄒ 应 2\n你好 ㄋ ㄧ 2 ㄏ ㄠ 3\n长 ㄓ ㄤ 3\n里 ㄌ ㄧ 3\n找 ㄓ ㄠ 3");
  const say = (text) => toTokens(text, { english: new Map(), chinese });
  const tones = (text) => say(text).filter((t) => /^[1-5]$/.test(t)).join(" ");
  // two third tones in a row: the first rises
  assert.equal(tones("所以"), "2 3");
  assert.equal(tones("你好"), "2 3");
  // but not from one word to the next
  assert.equal(tones("里，找"), "3 3");
  // 一 and 不 rise before a fourth tone; 一 falls before any other, and stays level in a date
  assert.equal(tones("一下，一百，一月"), "2 4 4 3 1 4");
  assert.equal(tones("不对，不行"), "2 4 4 2");
  // 长 on its own is "long", not "to grow"
  assert.deepEqual(say("长"), ["ㄔ", "ㄤ", "2"]);
});

test("行 is a line when lines are counted, and the verb otherwise", () => {
  const chinese = parseDictionary("一 ㄧ 1\n行 ㄒ 应 2\n一行 ㄧ 4 ㄒ 应 2\n不行 ㄅ ㄨ 4 ㄒ 应 2\n行动 ㄒ 应 2 ㄉ 用 4\n这 ㄓ ㄜ 4\n几 ㄐ ㄧ 3\n代 ㄉ ㄞ 4\n人 ㄖ ㄣ 2\n吗 ㄇ ㄚ 5");
  const reading = (text) => toTokens(text, { english: new Map(), chinese }).join("");
  assert.equal(reading("一行代"), "ㄧ4ㄏㄤ2ㄉㄞ4");
  assert.equal(reading("几行"), "ㄐㄧ3ㄏㄤ2");
  assert.equal(reading("这行代"), "ㄓㄜ4ㄏㄤ2ㄉㄞ4");
  assert.equal(reading("不行"), "ㄅㄨ4ㄒ应2");
  assert.equal(reading("一行人"), "ㄧ4ㄒ应2ㄖㄣ2");
  assert.equal(reading("这行动"), "ㄓㄜ4ㄒ应2ㄉ用4");
  assert.equal(reading("这行吗"), "ㄓㄜ4ㄒ应2ㄇㄚ5");
});

test("a voice is a built-in name or one of the model's speakers", async () => {
  const resolve = (spec, narration = "Hello.") => resolveVoice({ spec, narration, log: () => {} });
  assert.equal((await resolve(undefined, "你好。")).key, (await resolve("lin")).key);
  assert.equal((await resolve(undefined)).key, (await resolve("maple")).key);
  await assert.rejects(resolve("edge:en-US-EmmaMultilingualNeural"), /Edge TTS was removed/);
  // maple is a name for the speaker af_maple; chen is zm_061 with another speaker mixed in
  assert.equal((await resolve("maple")).key, (await resolve("af_maple")).key);
  assert.notEqual((await resolve("chen")).key, (await resolve("zm_061")).key);
  assert.notEqual((await resolve("chen")).key, (await resolve("lin")).key);
  await assert.rejects(resolve("nobody"), /no voice called "nobody"/);
  await assert.rejects(resolve("constructor"), /no voice called/);
  assert.deepEqual(toTokens("constructor", { english: new Map([["constructor", ["k"]]]), chinese: new Map() }), ["k"]);
});

test("long direct-token input fits Kokoro in complete word and syllable batches", () => {
  for (const word of [["k", "ˈ", "æ", "t", " "], ["ㄓ", "ㄨ", "1"], Array(550).fill("t")]) {
    const tokens = Array.from({ length: 101 }, () => word).flat();
    const batches = tokenBatches(tokens);
    assert.deepEqual(batches.flat(), tokens);
    assert.ok(batches.every((batch) => batch.length <= 480));
    if (word.length < 480) assert.ok(batches.every((batch) => batch.at(-1) === word.at(-1)));
  }
});

test("mixing speakers blends their tables and leaves the others alone", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "drawcast-"));
  try {
    const [source, target] = [path.join(dir, "voices.bin"), path.join(dir, "mixed.bin")];
    // three speakers of two numbers each
    writeFileSync(source, Buffer.from(Float32Array.of(0, 0, 8, 4, 100, 100).buffer));
    await mixSpeakers(source, target, ["a", "b", "c"], { a: ["b", 0.25], b: ["a", 0.5] });
    const out = readFileSync(target);
    assert.deepEqual([...new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength))], [2, 1, 4, 2, 100, 100]);
    await assert.rejects(mixSpeakers(source, target, ["a", "b", "c", "d"], {}), /does not hold 4 speakers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wav helpers", () => {
  const samples = new Float32Array(480);
  samples.fill(0.5, 200, 300);
  const audio = { samples, sampleRate: 48000 };
  assert.equal(encodeWav(audio).length, 44 + 480 * 2);
  assert.equal(resample(audio, 24000).samples.length, 240);
  assert.equal(trimSilence(audio, 0).samples.length, 100);
});

test("quiet speech is preserved and digital silence yields no speech", () => {
  const samples = new Float32Array(16000);
  samples.fill(0.005, 2000, 14000);
  assert.equal(trimSilence({ samples, sampleRate: 16000 }, 0).samples.length, 12000);
  samples.fill(0);
  assert.equal(trimSilence({ samples, sampleRate: 16000 }).samples.length, 0);
});

function temporaryCache(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "drawcast-voice-"));
  const old = process.env.DRAWCAST_HOME;
  process.env.DRAWCAST_HOME = dir;
  t.after(() => {
    if (old === undefined) delete process.env.DRAWCAST_HOME;
    else process.env.DRAWCAST_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("corrupt cache entries are regenerated and cached timings match the actual rendered audio", async (t) => {
  const home = temporaryCache(t);
  const script = { steps: [{ say: "Check these four words." }] };
  const voice = { key: "timing", name: "timing", open: async () => async () => ({ sampleRate: 22050, samples: new Float32Array(5411).fill(0.5) }) };
  const run = () => narrate(script, voice, 1.3, () => {});
  const [first, other] = await Promise.all([run(), run()]);
  assert.deepEqual(first.steps, other.steps);
  const cache = path.join(home, "speech", voice.key);
  const [file] = readdirSync(cache);
  assert.deepEqual(readdirSync(cache), [file]);
  const wav = readFileSync(path.join(cache, file));
  writeFileSync(path.join(cache, file), wav.subarray(0, wav.length - 16));
  assert.equal((await cachedNarration(script, voice, 1.3)).cached, 0);
  const repaired = await run();
  const snapshot = await cachedNarration(script, voice, 1.3);
  assert.equal(snapshot.cached, 1);
  assert.deepEqual(repaired.steps, first.steps);
  assert.deepEqual(snapshot.steps, repaired.steps);
});

test("incomplete WAV metadata fails before resampling and streamed WAV data is accepted", async (t) => {
  const file = path.join(temporaryCache(t), "input.wav");
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

test("failed model downloads leave the previous installation intact and can be retried", async (t) => {
  temporaryCache(t);
  const model = path.join(modelsDir(), "kokoro-multi-lang-v1_1");
  mkdirSync(model, { recursive: true });
  for (const file of ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt"]) writeFileSync(path.join(model, file), "partial");
  assert.equal(modelsInstalled(), false);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("invalid archive"));
  const run = () => ensureModels(() => {});
  await Promise.all([assert.rejects(run(), /checksum/), assert.rejects(run(), /checksum/)]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(readdirSync(modelsDir()), ["kokoro-multi-lang-v1_1"]);
  await assert.rejects(run(), /checksum/);
  assert.equal(fetch.mock.callCount(), 2);
});

test("custom voices remove invalid output even when the command exits successfully", async (t) => {
  const home = temporaryCache(t);
  const helper = path.join(home, "invalid.cjs");
  writeFileSync(helper, 'require("node:fs").writeFileSync(process.env.DRAWCAST_OUT, "bad")');
  const voice = await resolveVoice({ narration: "", ttsCommand: `"${process.execPath}" "${helper}"`, log: () => {} });
  const say = await voice.open();
  await assert.rejects(say("Check the output."), /not a WAV/);
  assert.deepEqual(readdirSync(path.join(home, "tmp")), []);
});

test("relative voice commands in different projects keep separate speech caches", async (t) => {
  const old = process.cwd();
  const home = temporaryCache(t);
  const options = { narration: "", ttsCommand: "python my_tts.py", log: () => {} };
  const first = await resolveVoice(options);
  try {
    process.chdir(home);
    const second = await resolveVoice(options);
    assert.notEqual(first.key, second.key);
    assert.equal(second.key, (await resolveVoice(options)).key);
  } finally {
    process.chdir(old);
  }
});

test("cache write failures do not switch voices and silent scripts need no writable cache", async (t) => {
  const home = temporaryCache(t);
  const sentence = "This sentence cannot be saved.";
  const hash = createHash("sha256").update(sentence).digest("hex").slice(0, 24);
  const key = "offline";
  mkdirSync(path.join(home, "speech", key, hash + ".wav"), { recursive: true });
  let fallbackStarted = false;
  const voice = {
    name: key, key, open: async () => async () => ({ sampleRate: 24000, samples: Float32Array.of(0.75) }),
    fallback: { name: "fallback", key: "fallback", open: async () => { fallbackStarted = true; } },
  };
  await assert.rejects(narrate({ steps: [{ say: sentence }] }, voice, 1, () => {}), (e) => ["EPERM", "EISDIR", "EACCES", "ENOTEMPTY"].includes(e.code));
  assert.equal(fallbackStarted, false);
  const unavailable = path.join(home, "file");
  writeFileSync(unavailable, "not a directory");
  process.env.DRAWCAST_HOME = unavailable;
  const silent = await narrate({ steps: [{}, {}] }, voice, 1, () => {});
  assert.deepEqual(silent.steps, [null, null]);
});

test("stereo float WAVs from a custom voice downmix and resample at their declared rate", async (t) => {
  const file = path.join(temporaryCache(t), "float.wav");
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

test("aborting one waiter keeps the shared download alive until its last caller cancels", async (t) => {
  temporaryCache(t);
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let aborted = 0;
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_, reject) => {
    began();
    signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true });
  }));
  const a = new AbortController();
  const b = new AbortController();
  const first = ensureModels(() => {}, a.signal);
  const second = ensureModels(() => {}, b.signal);
  await started;
  a.abort(new Error("first stopped"));
  await assert.rejects(first, /first stopped/);
  assert.equal(aborted, 0);
  b.abort(new Error("second stopped"));
  await assert.rejects(second, /second stopped/);
  assert.equal(aborted, 1);
  assert.deepEqual(readdirSync(modelsDir()), []);
});

test("cancelling narration stops its custom command and skips remaining sentences and fallback", async (t) => {
  const home = temporaryCache(t);
  const helper = path.join(home, "wait.cjs");
  const pidFile = path.join(home, "pid");
  writeFileSync(helper, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 10000);');
  const voice = await resolveVoice({ narration: "", ttsCommand: `"${process.execPath}" "${helper}" "${pidFile}"`, log: () => {} });
  let opened = false;
  voice.fallback = { name: "backup", key: "backup", open: async () => { opened = true; throw new Error("fallback opened"); } };
  const controller = new AbortController();
  const script = { steps: [{ say: "This first sentence waits. There are four more words." }] };
  const lines = [];
  const job = narrate(script, voice, 1, (line) => lines.push(line), undefined, controller.signal);
  const pid = await t.waitFor(() => {
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    return pid;
  }, { interval: 10, timeout: 5000 });
  controller.abort(new Error("render ended"));
  await assert.rejects(job, /render ended/);
  // The shell can close before the OS reaps its killed child.
  await t.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }), { interval: 10, timeout: 2000 });
  assert.equal(opened, false);
  assert.equal(lines.filter((line) => line.includes("speaking")).length, 1);
  assert.deepEqual(readdirSync(path.join(home, "speech", voice.key)), []);
});

test("a tempo change alters the length and keeps the pitch", () => {
  const sampleRate = 48000;
  const tone = { samples: Float32Array.from({ length: sampleRate }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / sampleRate)), sampleRate };
  const pitch = ({ samples }) => {
    let rises = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) rises++;
    return rises / (samples.length / sampleRate);
  };
  for (const speed of [0.8, 1.25]) {
    const out = changeTempo(tone, speed);
    assert.ok(Math.abs(out.samples.length / sampleRate - 1 / speed) < 0.05, `length at ${speed}`);
    assert.ok(Math.abs(pitch(out) - 220) < 5, `pitch at ${speed}`);
  }
});
