import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize } from "../src/voice/normalize.ts";
import { parseDictionary, toTokens } from "../src/voice/tokenize.ts";
import { encodeWav, resample, trimSilence } from "../src/voice/wav.ts";

// a dictionary that knows every word but these, and "pronounces" a word as itself
const UNKNOWN = new Set(["running", "runn", "bak", "codebase", "codebase's", "readme", "baked", "github", "xkcd"]);
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

test("an unknown word is built from known ones, or spelled", () => {
  const out = normalize("running the codebase's README on GitHub, baked by xkcd", lexicon);
  assert.equal(out.text, "running the codebase's readme on git hub, baked by ltrx ltrk ltrc ltrd");
  assert.equal(out.entries.get("running"), "run ɪ ŋ");
  assert.equal(out.entries.get("baked"), "bake d");
  assert.equal(out.entries.get("readme"), "read me");
});

test("tokens keep a space between English words and none around Chinese", () => {
  const dict = {
    english: parseDictionary("it ɪ t\nasks æ s k s\nreact ɹ i æ k t"),
    chinese: parseDictionary("银 y in2\n行 x ing2\n银行 y in2 h ang2\n用 y ong4"),
  };
  assert.deepEqual(toTokens("It asks.", dict), ["ɪ", "t", " ", "æ", "s", "k", "s", "."]);
  assert.deepEqual(toTokens("银行用react，行", dict), ["y", "in2", "h", "ang2", "y", "ong4", "ɹ", "i", "æ", "k", "t", ",", "x", "ing2"]);
});

test("wav helpers", () => {
  const samples = new Float32Array(480);
  samples.fill(0.5, 200, 300);
  const audio = { samples, sampleRate: 48000 };
  assert.equal(encodeWav(audio).length, 44 + 480 * 2);
  assert.equal(resample(audio, 24000).samples.length, 240);
  assert.equal(trimSilence(audio, 0).samples.length, 100);
});
