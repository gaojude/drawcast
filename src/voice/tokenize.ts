/**
 * Text -> the model's input tokens: IPA symbols for English, initials and finals for Chinese.
 *
 * sherpa-onnx can do this itself from a dictionary file, but it leaves out the space between English
 * words, which the model was trained with; without it words run into each other ("it asks a" comes out
 * as "it tasks a"). So the lookup is done here and the model gets finished tokens.
 *
 * Its Chinese dictionary gives a word its spoken tones (你好 is ni2 hao3) but covers only the words it
 * lists. Everything else is looked up character by character, and the tone changes between those
 * characters are worked out here.
 */

export interface Dictionaries {
  /** English word -> IPA symbols */
  english: Map<string, string[]>;
  /** Chinese character or word -> initials and finals with tones, e.g. 你好 -> n i3 h ao3 */
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

export function toTokens(text: string, dict: Dictionaries): string[] {
  const out: string[] = [];
  let before: "english" | "chinese" | null = null;
  for (const piece of text.toLowerCase().match(PIECE) ?? []) {
    if (PUNCTUATION[piece]) {
      out.push(PUNCTUATION[piece]);
      before = null;
    } else if (piece.charCodeAt(0) < 128) {
      const symbols = dict.english.get(piece);
      if (!symbols) continue;
      // The model's training text had a space where English follows English or Chinese, and none
      // where Chinese follows English.
      if (before) out.push(" ");
      out.push(...symbols);
      before = "english";
    } else {
      out.push(...chinese(piece, dict.chinese));
      before = "chinese";
    }
  }
  return out;
}

/** One syllable: its tokens (an initial, if it has one, and a final that ends in the tone). */
interface Syllable {
  character: string;
  tokens: string[];
  /** part of a dictionary word, whose tones are already the spoken ones */
  inWord: boolean;
}

const tone = (s: Syllable) => Number(s.tokens.at(-1)!.at(-1));
const setTone = (s: Syllable, t: number) => (s.tokens[s.tokens.length - 1] = s.tokens.at(-1)!.slice(0, -1) + t);

/** Characters whose commonest reading, when they stand alone, is not the dictionary's first. */
const ALONE: Record<string, string[]> = { 长: ["ch0", "ang2"], 得: ["d0", "e5"], 地: ["d0", "e5"] };
/** 一 keeps its first tone in a number or a date: before one of these, or after one of the others. */
const AFTER_ONE = "二三四五六七八九零月日号";
const BEFORE_ONE = "一二三四五六七八九零十百千万亿第";

/** A run of Chinese characters as tokens, with the tones as they are spoken. */
function chinese(run: string, words: Map<string, string[]>): string[] {
  const syllables: Syllable[] = [];
  // the longest dictionary word first: 银行 is not 银 + 行 read on its own
  for (let i = 0; i < run.length; ) {
    let length = Math.min(MAX_WORD, run.length - i);
    while (length > 1 && !words.has(run.slice(i, i + length))) length--;
    const word = run.slice(i, i + length);
    const tokens = (length === 1 && ALONE[word]) || words.get(word) || [];
    // a syllable ends at its final, which carries the tone
    let start = 0;
    let n = 0;
    tokens.forEach((token, at) => {
      if (!/[1-5]$/.test(token)) return;
      syllables.push({ character: word[n++] ?? "", tokens: tokens.slice(start, at + 1), inWord: length > 1 });
      start = at + 1;
    });
    i += length;
  }

  // Tone sandhi, for what the dictionary's words do not already cover. From the right, so that a row
  // of third tones alternates: 我很好 is wo3 hen2 hao3.
  for (let i = syllables.length - 2; i >= 0; i--) {
    const [s, next, previous] = [syllables[i], syllables[i + 1], syllables[i - 1]];
    if (s.inWord) continue;
    if (s.character === "一") {
      // yi2 before a fourth tone, yi4 before the others
      const counted = AFTER_ONE.includes(next.character) || (previous && BEFORE_ONE.includes(previous.character));
      if (!counted) setTone(s, tone(next) === 4 ? 2 : 4);
    } else if (s.character === "不") {
      if (tone(next) === 4) setTone(s, 2);
    } else if (tone(s) === 3 && tone(next) === 3) {
      setTone(s, 2);
    }
  }
  return syllables.flatMap((s) => s.tokens);
}
