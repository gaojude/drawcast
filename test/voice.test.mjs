import assert from "node:assert/strict";
import { test } from "node:test";
import { guess } from "../src/voice/guess.ts";
import { normalize } from "../src/voice/normalize.ts";
import { parseDictionary, toTokens } from "../src/voice/tokenize.ts";
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

test("spelling rules give a recognisable reading", () => {
  const read = (word) => guess(word)?.replaceAll(" ", "");
  assert.equal(read("redis"), "ɹˈɛdɪs");
  assert.equal(read("ubuntu"), "uːbˈʌntuː");
  assert.equal(read("vite"), "vˈaɪt");
  assert.equal(read("tokio"), "tˈoʊkioʊ");
  assert.equal(read("vercel"), "vˈɜːsɛl");
  assert.equal(read("grpc"), undefined);
});

test("tokens keep a space between English words and none around Chinese", () => {
  const dict = {
    english: parseDictionary("it ɪ t\nasks æ s k s\nreact ɹ i æ k t"),
    chinese: parseDictionary("银 y in2\n行 x ing2\n银行 y in2 h ang2\n用 y ong4"),
  };
  assert.deepEqual(toTokens("It asks.", dict), ["ɪ", "t", " ", "æ", "s", "k", "s", "."]);
  assert.deepEqual(toTokens("银行用 react，行", dict), ["y", "in2", "h", "ang2", "y", "ong4", " ", "ɹ", "i", "æ", "k", "t", ",", "x", "ing2"]);
  assert.deepEqual(toTokens("react用", dict), ["ɹ", "i", "æ", "k", "t", "y", "ong4"]);
});

test("tones change as they do in speech", () => {
  const chinese = parseDictionary("我 w0 o3\n很 h0 en3\n好 h0 ao3\n一 y0 i1\n个 g0 e4\n天 t0 ian1\n十 sh0 i2\n不 b0 u4\n是 sh0 i4\n行 x0 ing2\n你好 n0 i2 h0 ao3\n地 d0 i4\n跑 p0 ao3");
  const tones = (text) => toTokens(text, { english: new Map(), chinese }).filter((t) => /[1-5]$/.test(t)).join(" ");
  // two third tones in a row: the first rises
  assert.equal(tones("我很好"), "o3 en2 ao3");
  assert.equal(tones("你好"), "i2 ao3");
  // 一 and 不 before a fourth tone rise; 一 before any other falls, and in a number stays level
  assert.equal(tones("一个，一天，十一"), "i2 e4 i4 ian1 i2 i1");
  assert.equal(tones("不是，不行"), "u2 i4 u4 ing2");
  // 地 on its own is the particle
  assert.equal(tones("好地跑"), "ao3 e5 ao3");
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