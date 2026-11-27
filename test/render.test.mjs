import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordInBrowser, tell } from "../src/render/render.ts";
import { findFfmpeg } from "../src/render/encode.ts";
import { avcCodecs, colorTags, segmentFrames } from "../src/shared/h264.ts";
import { SAMPLE_RATE, narrate } from "../src/voice/narrate.ts";

test("the encoder is asked for the lowest H.264 level that holds the video", () => {
  assert.deepEqual(avcCodecs(1920, 1080, 30), ["avc1.640028", "avc1.42e028"]);
  assert.deepEqual(avcCodecs(1920, 1080, 60), ["avc1.64002a", "avc1.42e02a"]);
  assert.deepEqual(avcCodecs(1280, 720, 30), ["avc1.64001f", "avc1.42e01f"]);
  assert.deepEqual(avcCodecs(3840, 2160, 30), ["avc1.640033", "avc1.42e033"]);
  assert.deepEqual(avcCodecs(3840, 2160, 60), ["avc1.640034", "avc1.42e034"]);
  assert.deepEqual(avcCodecs(4096, 64, 30), ["avc1.640028", "avc1.42e028"]);
});

test("a video H.264 cannot hold gets no encoder", () => {
  assert.deepEqual(avcCodecs(1921, 1080, 30), []);
  assert.deepEqual(avcCodecs(7680, 4320, 30), []);
  assert.deepEqual(avcCodecs(3840, 2160, 120), []);
  assert.deepEqual(avcCodecs(64, 10000, 1), []);
  assert.deepEqual(avcCodecs(0, 100, 30), []);
  assert.deepEqual(avcCodecs(100, 100, -1), []);
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

test("a rejected browser stream leaves the page open for the ffmpeg fallback", async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return t.skip("requires ffmpeg");
  const previous = process.env.DRAWCAST_ENCODER;
  delete process.env.DRAWCAST_ENCODER;
  t.after(() => { if (previous !== undefined) process.env.DRAWCAST_ENCODER = previous; });
  const dir = mkdtempSync(path.join(tmpdir(), "drawcast-mux-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let stops = 0;
  let segment = Buffer.alloc(0);
  const player = {
    encoder: async () => ({ encoder: { lanes: 1, color: null }, tried: [] }),
    encodeSegment: async () => segment,
    stopEncoding: async () => { stops++; },
    close: () => assert.fail("closed the page before fallback"),
  };
  const telling = { round: 0, frames: 1, samples: 48000, duration: 1, cover: null, sound: () => new Float32Array(48000) };
  const options = { output: path.join(dir, "out.mp4"), fps: 1, guess: 1, cover: false, log: () => {} };
  assert.equal(await recordInBrowser(player, telling, options), false);
  // Give ffmpeg a complete video and audio, then make opening the output file fail.
  segment = execFileSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", "color=s=16x16:r=1", "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "pipe:1"]);
  assert.equal(await recordInBrowser(player, telling, { ...options, output: path.join(dir, "absent", "out.mp4") }), false);
  assert.equal(stops, 2);
});

/** A voice that takes a moment over each sentence and notes how many it was asked for at once. */
function slowVoice(parallel) {
  const voice = { name: "test", key: `test-${parallel ?? "one"}`, parallel, said: [], most: 0, now: 0 };
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
    // which voice, then a line for each sentence spoken
    assert.equal(lines[0], "  voice: test, 6 sentence(s), 0 from the cache");
    assert.equal(lines.length, 7);

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
    const narration = await narrate(script, voice, 1, () => {}, {
      spoken(index, step, clip) {
        heard.push([index, step?.captions.map((c) => c.text) ?? null, clip?.samples.length ?? null]);
        if (index === 0) open();
      },
      startOver: () => assert.fail("the voice did not give up"),
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
    await narrate(script, again, 1, () => {}, { spoken: (index) => heard.push(index), startOver: () => assert.fail("no voice gave up") });
    assert.deepEqual(heard, [0, 1, 2]);
  });
});

/**
 * A voice like `slowVoice` that cannot say some sentences, with another voice to say the script instead.
 * It takes until `when` to find that it cannot, as a voice on the far side of a connection does.
 */
function failingVoice(cannotSay, fallback, when = Promise.resolve()) {
  const voice = slowVoice(1);
  voice.key = "test-gives-up";
  voice.fallback = fallback;
  const open = voice.open;
  voice.open = async () => {
    const say = await open();
    return async (sentence) => {
      if (!cannotSay.includes(sentence)) return say(sentence);
      await when;
      throw new Error(`cannot say "${sentence}"`);
    };
  };
  return voice;
}

test("a voice that gives up partway hands the whole script to its fallback, and says so", async () => {
  await inCache(async () => {
    const other = slowVoice(2);
    other.key = "test-fallback";
    // it gives up a moment after its first step (and the silent one behind it) has been reported
    let giveUp;
    const voice = failingVoice([FOUR], other, new Promise((resolve) => (giveUp = resolve)));
    const events = [];
    const lines = [];
    const narration = await narrate(script, voice, 1, (l) => lines.push(l), {
      spoken(index) {
        events.push(index);
        if (events.length === 1) setTimeout(giveUp, 20);
      },
      startOver: () => events.push("over"),
    });
    // the first step was reported in the first voice, and then all of them in the second
    assert.deepEqual(events, [0, 1, "over", 0, 1, 2]);
    assert.deepEqual(voice.said, [ONE, TWO, THREE], "nothing is asked of a voice that has given up");
    assert.deepEqual([...other.said].sort(), [ONE, TWO, THREE, FOUR, FIVE, SIX].sort(), "the second voice says all of it, not the rest of it");
    assert.equal(narration.steps.length, 3);
    assert.ok(lines.some((l) => /the built-in voice will: cannot say/.test(l)));
  });
});

test("a voice that cannot start hands over before anything is reported, so nothing starts over", async () => {
  await inCache(async () => {
    const other = slowVoice(2);
    other.key = "test-fallback";
    const voice = failingVoice([], other);
    voice.open = async () => {
      throw new Error("edge-tts was not found");
    };
    const events = [];
    await narrate(script, voice, 1, () => {}, { spoken: (index) => events.push(index), startOver: () => events.push("over") });
    assert.deepEqual(events, [0, 1, 2]);
  });
});

/** A player that schedules like the page does, but simply: a step lasts as long as its audio (a silent one a second), plus half a second. */
function toyPlayer(steps) {
  let starts = [];
  let ends = [];
  let at = 0.5;
  const player = {
    sent: [],
    startedOver: 0,
    async schedule(audio) {
      player.sent.push(audio);
      for (const a of audio) {
        starts.push(at);
        at += (a?.duration ?? 1) + 0.5;
        ends.push(at - 0.05);
      }
      const duration = starts.length === steps ? at + 1 : null;
      if (duration !== null) ends[ends.length - 1] = duration;
      return { stepStarts: [...starts], stepEnds: [...ends], stepDone: [...ends], settled: duration ?? at, duration };
    },
    async startOver() {
      player.startedOver++;
      starts = [];
      ends = [];
      at = 0.5;
    },
  };
  return player;
}

const tone = (seconds, level) => ({ samples: new Float32Array(seconds * SAMPLE_RATE).fill(level), sampleRate: SAMPLE_RATE });
const audioOf = (seconds) => ({ duration: seconds, tokens: [], captions: [{ text: "said", t0: 0, t1: seconds }] });

test("voice fallback discards already queued audio and video before writing a late cover", { timeout: 15000 }, async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || process.env.DRAWCAST_ENCODER === "ffmpeg") return t.skip("requires the browser muxing path and ffmpeg");
  const dir = mkdtempSync(path.join(tmpdir(), "drawcast-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "video.mp4");
  const keyframe = execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=s=16x16:r=4", "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "pipe:1"]);
  let listener, finishSpeech;
  const player = toyPlayer(2);
  let restarted = false;
  player.encoder = async () => ({ encoder: { lanes: 1, color: null }, tried: [] });
  player.encodeSegment = async (_lane, _first, count) => {
    if (!restarted) {
      restarted = true;
      listener.startOver();
      listener.spoken(0, null, null);
      listener.spoken(1, null, null);
      finishSpeech();
    }
    return Buffer.concat(Array(count).fill(keyframe));
  };
  player.close = async () => {};
  const telling = tell(Promise.resolve(player), { steps: [{}, {}] }, (events) => new Promise((resolve) => {
    listener = events;
    finishSpeech = resolve;
    listener.spoken(0, audioOf(3), tone(3, 0.5));
  }), { fps: 4, captions: false, cover: 2, log() {} });
  const encoded = await recordInBrowser(player, telling, { output, ffmpeg, fps: 4, guess: 4, cover: true, log() {} });
  assert.equal(encoded, true);
  assert.equal(telling.round, 1);
  const hashes = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-map", "0:v:0", "-f", "framemd5", "-"], { encoding: "utf8" });
  assert.equal(hashes.trim().split(/\r?\n/).filter((line) => !line.startsWith("#")).length, telling.frames);
  const packetInfo = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-map", "0:v:0", "-c:v", "copy", "-f", "framemd5", "-"], { encoding: "utf8" });
  const [, numerator, denominator] = /^#tb 0: (\d+)\/(\d+)/m.exec(packetInfo);
  const tick = Number(numerator) / Number(denominator);
  const packets = packetInfo.trim().split(/\r?\n/).filter((line) => !line.startsWith("#"));
  assert.equal(packets.length, telling.frames);
  for (const [i, packet] of packets.entries()) {
    const [, dts, pts, duration] = packet.split(",").map(Number);
    assert.equal(dts, pts);
    assert.equal(pts * tick, i / 4);
    assert.equal(duration * tick, 1 / 4);
  }
  const sound = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-map", "0:a:0", "-f", "s16le", "-"]);
  assert.ok(sound.length >= telling.samples * 2);
  assert.ok(sound.every((b) => b === 0), "the abandoned voice must not be audible");
});

test("a video settles a step at a time, as its narration is heard", async () => {
  const player = toyPlayer(3);
  const lines = [];
  let heard;
  const telling = tell(Promise.resolve(player), script, (listener) => new Promise(() => (heard = listener.spoken)), { fps: 10, captions: false, log: (l) => lines.push(l) });
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
  assert.deepEqual(await telling.whole, { duration: 7, frames: 70, index: { frames: 70, stepFrames: [29, 44, 69] } });
  assert.deepEqual(lines, ["Video: 7.0 s, 70 frames"]);
  // the last step starts at 4.5 s
  const end = telling.sound(4 * SAMPLE_RATE, 7 * SAMPLE_RATE);
  assert.deepEqual([end[0.5 * SAMPLE_RATE - 1], end[0.5 * SAMPLE_RATE], end[1.5 * SAMPLE_RATE - 1], end[1.5 * SAMPLE_RATE]], [0, 0.25, 0.25, 0]);
});

test("when the narration starts over in another voice, nothing is settled any more", async () => {
  const player = toyPlayer(3);
  let listener;
  const telling = tell(Promise.resolve(player), script, (l) => new Promise(() => (listener = l)), { fps: 10, captions: true, log: () => {} });
  let more = telling.more();
  listener.spoken(0, audioOf(2), tone(2, 0.5));
  await more;
  assert.deepEqual([telling.frames, telling.round], [30, 0]);

  // whoever was waiting for more is woken, to find that what it made is void
  more = telling.more();
  listener.startOver();
  await more;
  assert.deepEqual([telling.frames, telling.samples, telling.duration, telling.round], [0, 0, null, 1]);

  // the other voice takes four seconds over the first step, and the page schedules it from the start again
  more = telling.more();
  listener.spoken(0, audioOf(4), tone(4, 0.125));
  await more;
  assert.equal(player.startedOver, 1);
  assert.deepEqual([telling.frames, telling.samples, telling.round], [50, 5 * SAMPLE_RATE, 1]);
  const sound = telling.sound(0, telling.samples);
  assert.deepEqual([sound[0.5 * SAMPLE_RATE], sound[4.5 * SAMPLE_RATE - 1], sound[4.5 * SAMPLE_RATE]], [0.125, 0.125, 0]);

  more = telling.more();
  listener.spoken(1, null, null);
  listener.spoken(2, audioOf(1), tone(1, 0.125));
  await more;
  assert.deepEqual(await telling.whole, { duration: 9, frames: 90, index: { frames: 90, stepFrames: [49, 64, 89] } });
});

test("the cover is known as soon as the step it shows is spoken", async () => {
  const telling = (cover) => {
    let listener;
    const t = tell(Promise.resolve(toyPlayer(3)), script, (l) => new Promise(() => (listener = l)), { fps: 10, captions: true, cover, log: () => {} });
    const hear = async (...steps) => {
      const more = t.more();
      for (const [index, seconds] of steps) listener.spoken(index, seconds && audioOf(seconds), seconds && tone(seconds, 0.5));
      await more;
    };
    return { t, hear, listener: () => listener };
  };

  // the cover is the first step as it is done, known as soon as that step is scheduled
  const first = telling(1);
  assert.equal(first.t.cover, null);
  await first.hear([0, 2]);
  assert.equal(first.t.cover, 1);
  // another voice starts over, and its first step ends elsewhere
  const more = first.t.more();
  first.listener().startOver();
  await more;
  assert.equal(first.t.cover, null);
  await first.hear([0, 4]);
  assert.equal(first.t.cover, 1);

  // a later step's cover waits for that step, and the last step ends with the video
  const last = telling(3);
  await last.hear([0, 2]);
  assert.equal(last.t.cover, null);
  await last.hear([1, null], [2, 1]);
  assert.deepEqual([last.t.cover, last.t.duration], [3, 7]);

  const none = telling(null);
  await none.hear([0, 2]);
  assert.equal(none.t.cover, null);
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

test("a voice that finishes early and an unrepresentable schedule both fail the render", async () => {
  const options = { fps: 30, captions: true, log() {} };
  const player = toyPlayer(1);
  const incomplete = tell(Promise.resolve(player), { steps: [{}, {}] }, async (listener) => listener.spoken(0, null, null), options);
  await assert.rejects(incomplete.whole, /after 1 of 2 steps/);
  player.schedule = async () => ({ settled: 1e300, duration: 1e300, stepStarts: [0], stepDone: [1e300] });
  const oversized = tell(Promise.resolve(player), { steps: [{}] }, async (listener) => listener.spoken(0, null, null), options);
  await assert.rejects(oversized.whole, /timeline is too long/);
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
