/**
 * Text -> the model's input tokens: IPA symbols for English, initials and finals for Chinese.
 *
 * sherpa-onnx can do this itself from a dictionary file, but it leaves out the space between English
 * words, which the model was trained with; without it words run into each other ("it asks a" comes out
 * as "it tasks a"). So the lookup is done here and the model gets finished tokens.
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
  let afterEnglish = false;
  for (const piece of text.toLowerCase().match(PIECE) ?? []) {
    if (PUNCTUATION[piece]) {
      out.push(PUNCTUATION[piece]);
    } else if (piece.charCodeAt(0) < 128) {
      const symbols = dict.english.get(piece);
      if (!symbols) continue;
      if (afterEnglish) out.push(" ");
      out.push(...symbols);
      afterEnglish = true;
    } else {
      // the longest dictionary word first: 银行 is not 银 + 行 read on its own
      for (let i = 0; i < piece.length; ) {
        let length = Math.min(MAX_WORD, piece.length - i);
        while (length > 1 && !dict.chinese.has(piece.slice(i, i + length))) length--;
        out.push(...(dict.chinese.get(piece.slice(i, i + length)) ?? []));
        i += length;
      }
      afterEnglish = false;
    }
  }
  return out;
}
