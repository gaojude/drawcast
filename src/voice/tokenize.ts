/**
 * Text -> the model's input tokens: phonemes for English, bopomofo with tone numbers for Chinese.
 *
 * sherpa-onnx can do this itself from the model's dictionaries, but it leaves out any English word they
 * lack without saying so, and it has no tone changes for Chinese words they do not list. So the lookup
 * is done here, where a missing word can be given a pronunciation first, and the model gets finished
 * tokens.
 *
 * The Chinese dictionary gives a word its spoken tones (你好 is ni2 hao3) but covers only the words it
 * lists. Everything else is looked up character by character, and the tone changes inside a word are
 * worked out here.
 */

export interface Dictionaries {
  /** English word -> phonemes, e.g. voice -> v ˈ Y s */
  english: Map<string, string[]>;
  /** Chinese character or word -> syllables that each end in a tone number, e.g. 你好 -> ㄋ ㄧ 2 ㄏ ㄠ 3 */
  chinese: Map<string, string[]>;
}

/** Parses `word token token ...` lines. */
export function parseDictionary(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const [word, ...symbols] = line.trim().split(/\s+/);
    if (word && symbols.length && !out.has(word)) out.set(word, symbols);
  }
  return out;
}

const PUNCTUATION: Record<string, string> = { "，": ",", "、": ",", "；": ";", "：": ",", ":": ",", "。": ".", "？": "?", "！": "!", ",": ",", ".": ".", ";": ";", "?": "?", "!": "!" };
const PIECE = /[a-z]+(?:'[a-z]+)*|[㐀-鿿]+|[，、；：:。？！,.;?!]/g;
/** The longest Chinese word worth looking up; longer dictionary entries are rare. */
const MAX_WORD = 6;
const VOWEL = /^[AIOWYaeiouæɐɑɔəɛɜɪʊʌᵊᵻ]/;

export function toTokens(text: string, dict: Dictionaries): string[] {
  const pieces = text.toLowerCase().match(PIECE) ?? [];
  const out: string[] = [];
  let before: "english" | "chinese" | null = null;
  pieces.forEach((piece, i) => {
    if (PUNCTUATION[piece]) {
      out.push(PUNCTUATION[piece]);
      before = null;
    } else if (piece.charCodeAt(0) < 128) {
      const phones = english(piece, pieces[i + 1], dict.english);
      if (!phones) return;
      // English words are a space apart, from each other and from the Chinese around them
      if (out.length) out.push(" ");
      out.push(...phones);
      before = "english";
    } else {
      if (before === "english") out.push(" ");
      out.push(...chinese(piece, dict.chinese));
      before = "chinese";
    }
  });
  return out;
}

function english(word: string, next: string | undefined, words: Map<string, string[]>): string[] | undefined {
  // "the" is "thee" before a vowel: the arrow, the end
  if (word === "the") {
    const first = next === undefined ? undefined : words.get(next)?.find((p) => p !== "ˈ" && p !== "ˌ");
    if (first && VOWEL.test(first)) return ["ð", "i"];
  }
  return words.get(word);
}

/** One syllable: its tokens, the last of which is the tone. */
interface Syllable {
  character: string;
  /** which word of the sentence it belongs to */
  word: number;
  tokens: string[];
  /** part of a dictionary word, whose tones are already the spoken ones */
  inWord: boolean;
  /** the first character of a dictionary word */
  startsWord: boolean;
}

const tone = (s: Syllable) => Number(s.tokens.at(-1));
const setTone = (s: Syllable, t: number) => (s.tokens[s.tokens.length - 1] = String(t));

/** Characters whose commonest reading, when they stand alone, is not the dictionary's. */
const ALONE: Record<string, string[]> = { 长: ["ㄔ", "ㄤ", "2"] };
/** 一 keeps its first tone in a number or a date: before one of these, or after one of the others. */
const AFTER_ONE = "二三四五六七八九零月日号";
const BEFORE_ONE = "一二三四五六七八九零十百千万亿第";
/** After one of these, 行 is a line being counted (hang2): 一行代码, 第三行, 这行. The dictionary has the verb (xing2). */
const COUNTS_LINES = "一二两三四五六七八九十百千万几每多数这那";
const LINE = ["ㄏ", "ㄤ", "2"];

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** A run of Chinese characters as tokens, with the tones as they are spoken. */
function chinese(run: string, words: Map<string, string[]>): string[] {
  // the word each character is in, for words the dictionary does not list
  const wordAt: number[] = [];
  [...segmenter.segment(run)].forEach((s, n) => wordAt.push(...Array(s.segment.length).fill(n)));

  const syllables: Syllable[] = [];
  // the longest dictionary word first: 银行 is not 银 + 行 read on its own
  for (let i = 0; i < run.length; ) {
    let length = Math.min(MAX_WORD, run.length - i);
    while (length > 1 && !words.has(run.slice(i, i + length))) length--;
    const word = run.slice(i, i + length);
    const tokens = (length === 1 && ALONE[word]) || words.get(word) || [];
    // a syllable ends at its tone
    let start = 0;
    let n = 0;
    tokens.forEach((token, at) => {
      if (!/^[1-5]$/.test(token)) return;
      syllables.push({ character: word[n] ?? "", word: wordAt[i + n], tokens: tokens.slice(start, at + 1), inWord: length > 1, startsWord: length > 1 && n === 0 });
      n++;
      start = at + 1;
    });
    i += length;
  }

  syllables.forEach((s, i) => {
    const [previous, next] = [syllables[i - 1]?.character, syllables[i + 1]?.character];
    // not 行动, not 一行人, and not "这行吗"
    if (s.character !== "行" || s.startsWord || !previous || !COUNTS_LINES.includes(previous) || next === "人") return;
    if ("这那".includes(previous) && (!next || "不吗吧了的".includes(next))) return;
    s.tokens = [...LINE];
  });

  // Tone sandhi, for the words the dictionary does not list.
  const tones = syllables.map(tone);
  for (let i = 0; i < syllables.length - 1; i++) {
    const [s, next, previous] = [syllables[i], syllables[i + 1], syllables[i - 1]];
    if (s.inWord || s.word !== next.word) continue;
    if (s.character === "一") {
      // yi2 before a fourth tone, yi4 before the others
      const counted = AFTER_ONE.includes(next.character) || (previous && BEFORE_ONE.includes(previous.character));
      if (!counted) setTone(s, tones[i + 1] === 4 ? 2 : 4);
    } else if (s.character === "不") {
      if (tones[i + 1] === 4) setTone(s, 2);
    } else if (tones[i] === 3 && tones[i + 1] === 3) {
      // the first of two third tones rises: 所以 is suo2 yi3
      setTone(s, 2);
    }
  }
  return syllables.flatMap((s) => s.tokens);
}
