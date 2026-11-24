import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guess } from "../src/voice/guess.ts";
import { normalize } from "../src/voice/normalize.ts";
import { parseDictionary, toTokens } from "../src/voice/tokenize.ts";
import { mixSpeakers, resolveVoice } from "../src/voice/voice.ts";
import { changeTempo, encodeWav, resample, trimSilence } from "../src/voice/wav.ts";

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
});

test("short acronyms are spelled, known words in capitals are read", () => {
  assert.equal(say("the API is OK"), "the ltra ltrp ltri is ltro ltrk");
  assert.equal(say("NASA"), "nasa");
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
  // left unset, it is the online voice for the language of the narration, falling back to a built-in one
  const zh = await resolve(undefined, "你好。");
  assert.equal(zh.key, (await resolve("edge:zh-CN-XiaoxiaoNeural")).key);
  assert.equal(zh.fallback.key, (await resolve("lin")).key);
  const en = await resolve(undefined);
  assert.equal(en.key, (await resolve("edge:en-US-EmmaMultilingualNeural")).key);
  assert.equal(en.fallback.key, (await resolve("maple")).key);
  // a voice that is named has nothing to fall back on
  assert.equal((await resolve("lin")).fallback, undefined);
  assert.equal((await resolve("edge:zh-CN-XiaoxiaoNeural")).fallback, undefined);
  // maple is a name for the speaker af_maple; chen is zm_061 with another speaker mixed in
  assert.equal((await resolve("maple")).key, (await resolve("af_maple")).key);
  assert.notEqual((await resolve("chen")).key, (await resolve("zm_061")).key);
  assert.notEqual((await resolve("chen")).key, (await resolve("lin")).key);
  await assert.rejects(resolve("nobody"), /no voice called "nobody"/);
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