// Regenerates assets/lexicon-en.txt.gz, the English pronunciation dictionary for the ZipVoice voice.
//
// The ZipVoice model released for sherpa-onnx comes with a Chinese dictionary only. This converts the
// US English dictionary shipped with sherpa-onnx's Kokoro model (misaki phonemes, Apache-2.0) into the
// IPA symbols ZipVoice was trained on.
//
//   node scripts/make-lexicon.mjs <kokoro-multi-lang-v1_1>/lexicon-us-en.txt <zipvoice-model>/tokens.txt
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [lexiconPath, tokensPath] = process.argv.slice(2);
if (!lexiconPath || !tokensPath) {
  console.error("usage: node scripts/make-lexicon.mjs <lexicon-us-en.txt> <tokens.txt>");
  process.exit(1);
}

// misaki writes diphthongs and affricates as one letter each
const IPA = { A: "eɪ", I: "aɪ", O: "oʊ", W: "aʊ", Y: "ɔɪ", ʧ: "tʃ", ʤ: "dʒ", ᵊ: "ə", T: "ɾ" };

// ZipVoice learned English from espeak-ng's transcriptions, which mark r-coloured and long vowels
// where misaki writes a plain vowel: "bird" is bˈɜːd, not bˈɜɹd, and "see" is sˈiː.
function espeak(ipa) {
  return ipa
    .replace(/ɜɹ/g, "ɜː")
    .replace(/əɹ/g, "ɚ")
    .replace(/([ɔɑ])ɹ/g, "$1ːɹ")
    .replace(/([ˈˌ])([iuɑɔ])(?!ː)/g, "$1$2ː");
}

const known = new Set(readFileSync(tokensPath, "utf8").split(/\r?\n/).map((line) => line.split("\t")[0]));

const entries = new Map();
for (const line of readFileSync(lexiconPath, "utf8").split(/\r?\n/)) {
  const [word, ...phones] = line.trim().split(/\s+/);
  if (!word || !phones.length) continue;
  const symbols = [...espeak(phones.map((p) => IPA[p] ?? p).join(""))];
  const key = word.toLowerCase();
  if (symbols.every((s) => known.has(s)) && !entries.has(key)) entries.set(key, symbols.join(" "));
}

// Letter names get entries of their own (ltra .. ltrz) for spelling out acronyms, which frees "a" to be
// the article. The source dictionary gives both articles their stressed forms.
for (const letter of "abcdefghijklmnopqrstuvwxyz") entries.set(`ltr${letter}`, entries.get(letter));
entries.set("a", "ə");
entries.set("the", "ð ə");

const text = [...entries].map(([word, phones]) => `${word} ${phones}`).join("\n") + "\n";
writeFileSync(new URL("../assets/lexicon-en.txt.gz", import.meta.url), gzipSync(text, { level: 9 }));
console.log(`${entries.size} words`);
