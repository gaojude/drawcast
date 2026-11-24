import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tell } from "../src/render/render.ts";
import { avcCodecs, colorTags, segmentFrames } from "../src/shared/h264.ts";
import { SAMPLE_RATE, narrate } from "../src/voice/narrate.ts";

test("the encoder is asked for the lowest H.264 level that holds the video", () => {
  assert.deepEqual(avcCodecs(1920, 1080, 30), ["avc1.640028", "avc1.42e028"]);
  assert.deepEqual(avcCodecs(1920, 1080, 60), ["avc1.64002a", "avc1.42e02a"]);
  assert.deepEqual(avcCodecs(1280, 720, 30), ["avc1.64001f", "avc1.42e01f"]);
  assert.deepEqual(avcCodecs(3840, 2160, 30), ["avc1.640033", "avc1.42e033"]);
  assert.deepEqual(avcCodecs(3840, 2160, 60), ["avc1.640034", "avc1.42e034"]);
});

test("a video H.264 cannot hold gets no encoder", () => {
  assert.deepEqual(avcCodecs(1921, 1080, 30), []);
  assert.deepEqual(avcCodecs(7680, 4320, 30), []);
  assert.deepEqual(avcCodecs(3840, 2160, 120), []);
});

test("the stream is labelled with the colour space the encoder says it used", () => {
  assert.equal(colorTags({ fullRange: false, matrix: "bt709", primaries: "bt709", transfer: "iec61966-2-1" }), "video_full_range_flag=0:colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1");
  assert.equal(colorTags({ fullRange: true, matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m" }), "video_full_range_flag=1:colour_primaries=6:transfer_characteristics=6:matrix_coefficients=6");
  // what the encoder leaves out, or names in a way H.264 has no number for, is left alone
  assert.equal(colorTags({ fullRange: null, matrix: "bt709", primaries: null, transfer: "something-new" }), "matrix_coefficients=1");
  assert.equal(colorTags({}), null);
  assert.equal(colorTags(null), null);
});

test("segments are a second to five seconds long, and several per encoder", () => {
  assert.equal(segmentFrames(9000, 30, 2), 150);
  assert.equal(segmentFrames(684, 30, 2), 114);
  assert.equal(segmentFrames(100, 30, 2), 30);
  assert.equal(segmentFrames(1200, 60, 1), 300);
  assert.equal(segmentFrames(1, 30, 2), 30);
});

/** A voice that takes a moment over each sentence and notes how many it was asked for at once. */
function slowVoice(parallel) {
  const voice = { key: `test-${parallel ?? "one"}`, parallel, said: [], most: 0, now: 0 };
  voice.open = async () => async (sentence) => {
    voice.most = Math.max(voice.most, ++voice.now);
    await new Promise((resolve) => setTimeout(resolve, 20));
    voice.now--;
    voice.said.push(sentence);
    // a tone as long as the sentence, loud enough to survive the trimming of silence
    return { samples: Float32Array.from({ length: sentence.length * 100 }, (_, i) => 0.5 * Math.sin(i / 5)), sampleRate: 48000 };
  };
  return voice;
}

const ONE = "The first box is drawn over here.";
const TWO = "Then an arrow leaves it for the second box.";
const THREE = "Nothing else on the canvas moves for a while.";
const FOUR = "A fourth sentence follows the silent step.";
const FIVE = "The fifth one is a little longer than the others are.";
const SIX = "Here is the sixth and last of them.";
// the second step is silent, and the third says one sentence the first has said already
const script = { drawcast: 1, steps: [{ say: `${ONE} ${TWO} ${THREE}` }, {}, { say: `${FOUR} ${FIVE} ${SIX} ${TWO}` }] };

async function inCache(run) {
  const home = mkdtempSync(path.join(tmpdir(), "drawcast-test-"));
  process.env.DRAWCAST_HOME = home;
  try {
    return await run(home);
  } finally {
    delete process.env.DRAWCAST_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

test("a voice that can speaks several sentences at once, and the steps come out in order", async () => {
  await inCache(async (home) => {
    const voice = slowVoice(3);
    const lines = [];
    const narration = await narrate(script, voice, 1, (l) => lines.push(l));
    assert.equal(voice.most, 3);
    // each sentence once, though one is said in two steps
    assert.deepEqual([...voice.said].sort(), [ONE, TWO, THREE, FOUR, FIVE, SIX].sort());
    assert.equal(lines.length, 6);

    assert.deepEqual(narration.steps.map((s) => s?.captions.map((c) => c.text) ?? null), [[ONE, TWO, THREE], null, [FOUR, FIVE, SIX, TWO]]);
    assert.equal(narration.clips[1], null);
    // a step's clip is its sentences in order with a pause between: the lengths say which went where
    const length = (text) => text.length * 100;
    const pause = Math.round(0.28 * 48000);
    const slack = 0.06 * 48000 * 3; // trimming keeps a little silence around each sentence
    const expected = length(ONE) + length(TWO) + length(THREE) + 2 * pause;
    assert.ok(Math.abs(narration.clips[0].samples.length - expected) <= slack, `${narration.clips[0].samples.length} vs ${expected}`);

    // nothing half-written is left behind, and a second render speaks nothing
    const cached = readdirSync(path.join(home, "speech", voice.key));
    assert.equal(cached.length, 6);
    assert.ok(cached.every((f) => f.endsWith(".wav")));
    const again = slowVoice(3);
    again.key = voice.key;
    await narrate(script, again, 1, () => {});
    assert.deepEqual(again.said, []);
  });
});

test("a voice that does not say so is asked for one sentence at a time", async () => {
  await inCache(async () => {
    const voice = slowVoice(undefined);
    await narrate(script, voice, 1, () => {});
    assert.equal(voice.most, 1);
    assert.deepEqual(voice.said, [ONE, TWO, THREE, FOUR, FIVE, SIX]);
  });
});

test("each step is reported as soon as it and those before it are spoken", async () => {
  await inCache(async () => {
    // the last step's own sentences are not spoken until the first step has been reported
    let open;
    const reported = new Promise((resolve) => (open = resolve));
    const voice = slowVoice(3);
    const start = voice.open;
    voice.open = async () => {
      const say = await start();
      return async (sentence) => {
        if ([FOUR, FIVE, SIX].includes(sentence)) await reported;
        return say(sentence);
      };
    };
    const heard = [];
    const narration = await narrate(script, voice, 1, () => {}, (index, step, clip) => {
      heard.push([index, step?.captions.map((c) => c.text) ?? null, clip?.samples.length ?? null]);
      if (index === 0) open();
    });
    assert.deepEqual(heard.map((h) => h[0]), [0, 1, 2]);
    assert.deepEqual(heard.map((h) => h[1]), [[ONE, TWO, THREE], null, [FOUR, FIVE, SIX, TWO]]);
    // what was reported is what is returned
    assert.deepEqual(heard.map((h) => h[2]), narration.clips.map((c) => c?.samples.length ?? null));
    assert.deepEqual(narration.steps.map((s) => s?.duration ?? null), heard.map((h, i) => (h[1] ? narration.steps[i].duration : null)));
  });
});

test("with everything in the cache, every step is reported without a voice", async () => {
  await inCache(async () => {
    const first = slowVoice(2);
    await narrate(script, first, 1, () => {});
    const heard = [];
    const again = slowVoice(2);
    again.key = first.key;
    again.open = async () => assert.fail("nothing is left to say");
    await narrate(script, again, 1, () => {}, (index) => heard.push(index));
    assert.deepEqual(heard, [0, 1, 2]);
  });
});

/** A player that schedules like the page does, but simply: a step lasts as long as its audio (a silent one a second), plus half a second. */
function toyPlayer(steps) {
  const starts = [];
  let at = 0.5;
  const sent = [];
  return {
    sent,
    async schedule(audio) {
      sent.push(audio);
      for (const a of audio) {
        starts.push(at);
        at += (a?.duration ?? 1) + 0.5;
      }
      const duration = starts.length === steps ? at + 1 : null;
      return { stepStarts: [...starts], settled: duration ?? at, duration };
    },
  };
}

const tone = (seconds, level) => ({ samples: new Float32Array(seconds * SAMPLE_RATE).fill(level), sampleRate: SAMPLE_RATE });
const audioOf = (seconds) => ({ duration: seconds, tokens: [], captions: [{ text: "said", t0: 0, t1: seconds }] });

test("a video settles a step at a time, as its narration is heard", async () => {
  const player = toyPlayer(3);
  const lines = [];
  let heard;
  const telling = tell(Promise.resolve(player), script, (h) => new Promise(() => (heard = h)), { fps: 10, captions: false, log: (l) => lines.push(l) });
  assert.deepEqual([telling.frames, telling.samples, telling.duration], [0, 0, null]);

  // the first step: spoken from 0.5 s to 2.5 s, so the second starts at 3 s and everything before that is settled
  let more = telling.more();
  heard(0, audioOf(2), tone(2, 0.5));
  await more;
  assert.deepEqual([telling.frames, telling.samples, telling.duration], [30, 3 * SAMPLE_RATE, null]);
  assert.deepEqual(player.sent[0][0].captions, [], "captions are turned off");
  const sound = telling.sound(0, telling.samples);
  assert.deepEqual([sound[0.5 * SAMPLE_RATE - 1], sound[0.5 * SAMPLE_RATE], sound[2.5 * SAMPLE_RATE - 1], sound[2.5 * SAMPLE_RATE]], [0, 0.5, 0.5, 0]);
  assert.deepEqual([...telling.sound(0.5 * SAMPLE_RATE - 2, 0.5 * SAMPLE_RATE + 2)], [0, 0, 0.5, 0.5], "any stretch of the sound can be asked for");
  assert.deepEqual(lines, []);

  // a silent step and the last one, heard together, are told to the page together
  more = telling.more();
  heard(1, null, null);
  heard(2, audioOf(1), tone(1, 0.25));
  await more;
  assert.equal(player.sent.length, 2);
  assert.deepEqual(player.sent[1].map((a) => a?.duration ?? null), [null, 1]);
  assert.deepEqual([telling.frames, telling.samples, telling.duration], [70, 7 * SAMPLE_RATE, 7]);
  assert.deepEqual(await telling.whole, { duration: 7, frames: 70 });
  assert.deepEqual(lines, ["Video: 7.0 s, 70 frames"]);
  // the last step starts at 4.5 s
  const end = telling.sound(4 * SAMPLE_RATE, 7 * SAMPLE_RATE);
  assert.deepEqual([end[0.5 * SAMPLE_RATE - 1], end[0.5 * SAMPLE_RATE], end[1.5 * SAMPLE_RATE - 1], end[1.5 * SAMPLE_RATE]], [0, 0.25, 0.25, 0]);
});

test("a narration that fails stops the telling", async () => {
  let fail;
  const telling = tell(Promise.resolve(toyPlayer(3)), script, () => new Promise((_, reject) => (fail = reject)), { fps: 10, captions: true, log: () => {} });
  const woken = telling.more();
  fail(new Error("the voice gave out"));
  await woken;
  assert.match(String(telling.failure), /gave out/);
  await assert.rejects(telling.more(), /gave out/);
  await assert.rejects(telling.whole, /gave out/);
});

test("a sentence that cannot be spoken fails the narration", async () => {
  await inCache(async () => {
    const voice = slowVoice(3);
    const open = voice.open;
    voice.open = async () => {
      const say = await open();
      return (sentence) => (sentence === FIVE ? Promise.reject(new Error("no voice for the fifth")) : say(sentence));
    };
    await assert.rejects(narrate(script, voice, 1, () => {}), /no voice for the fifth/);
  });
});
