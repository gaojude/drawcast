// Regenerates the built-in voices in assets/voices.
//
// A drawcast voice is a few seconds of speech for the model to imitate. The built-in ones are synthetic:
// they are spoken by Kokoro (Apache-2.0), so no real person's voice is shipped or cloned.
//
//   node scripts/make-voices.mjs <kokoro-multi-lang-v1_1 folder>
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kokoro = process.argv[2];
if (!kokoro) {
  console.error("usage: node scripts/make-voices.mjs <kokoro-multi-lang-v1_1 folder>");
  process.exit(1);
}

const ZH = "嗨，大家好！今天我们来聊一个特别有意思的话题，你准备好了吗？";
const EN = "Hey there! Today we are going to look at something really interesting. Are you ready?";

// The model speaks at the pace of the clip it imitates. Kokoro reads faster than a narrator should.
const PACE = { zh: 0.9, en: 0.78 };

// name -> Kokoro speaker
const VOICES = {
  chen: { speaker: "zm_061", language: "zh", description: "Mandarin, male", transcript: ZH },
  lin: { speaker: "zf_071", language: "zh", description: "Mandarin, female", transcript: ZH },
  maple: { speaker: "af_maple", language: "en", description: "American English, female", transcript: EN },
  sol: { speaker: "af_sol", language: "en", description: "American English, female, lower", transcript: EN },
};

// Speaker ids in the order of the model's voices.bin
const SPEAKERS = ["af_maple", "af_sol", "bf_vale", ...numbered("zf", [1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 32, 36, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49, 51, 59, 60, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 83, 84, 85, 86, 87, 88, 90, 92, 93, 94, 99]), ...numbered("zm", [9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 29, 30, 31, 33, 34, 35, 37, 41, 45, 50, 52, 53, 54, 55, 56, 57, 58, 61, 62, 63, 64, 65, 66, 68, 69, 80, 81, 82, 89, 91, 95, 96, 97, 98, 100])];

function numbered(prefix, ids) {
  return ids.map((n) => `${prefix}_${String(n).padStart(3, "0")}`);
}

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: {
      model: path.join(kokoro, "model.onnx"),
      voices: path.join(kokoro, "voices.bin"),
      tokens: path.join(kokoro, "tokens.txt"),
      lexicon: `${path.join(kokoro, "lexicon-us-en.txt")},${path.join(kokoro, "lexicon-zh.txt")}`,
    },
    numThreads: 4,
    provider: "cpu",
  },
});
if (tts.numSpeakers !== SPEAKERS.length) throw new Error(`expected ${SPEAKERS.length} speakers, the model has ${tts.numSpeakers}`);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets/voices");
mkdirSync(out, { recursive: true });
const index = {};
for (const [name, v] of Object.entries(VOICES)) {
  const audio = tts.generate({ text: v.transcript, sid: SPEAKERS.indexOf(v.speaker), speed: PACE[v.language] });
  sherpa.writeWave(path.join(out, `${name}.wav`), { samples: audio.samples, sampleRate: audio.sampleRate });
  index[name] = { language: v.language, description: v.description, transcript: v.transcript };
  console.log(name, v.speaker, `${(audio.samples.length / audio.sampleRate).toFixed(1)} s`);
}
writeFileSync(path.join(out, "voices.json"), `${JSON.stringify(index, null, 2)}\n`);
