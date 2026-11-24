import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveVoice } from "../src/voice/voice.ts";

const resolve = (spec) => resolveVoice({ spec, baseDir: ".", narration: "hello", log: () => {} });

test("an edge: voice is an online voice, cached under its own name", async () => {
  const emma = await resolve("edge:en-US-EmmaMultilingualNeural");
  const ava = await resolve("edge:en-US-AvaMultilingualNeural");
  assert.notEqual(emma.key, ava.key);
  assert.equal(emma.key, (await resolve("edge:en-US-EmmaMultilingualNeural")).key);
});

test("edge: with no name after it is an error", async () => {
  await assert.rejects(resolve("edge:"), /needs the name of a voice/);
});

test("without the edge-tts program, the error says how to get it", async () => {
  process.env.DRAWCAST_EDGE_TTS = "no-such-program-for-drawcast-tests";
  try {
    const voice = await resolve("edge:en-US-EmmaMultilingualNeural");
    await assert.rejects(voice.open(), /pipx install edge-tts/);
  } finally {
    delete process.env.DRAWCAST_EDGE_TTS;
  }
});
