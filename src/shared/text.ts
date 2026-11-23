/** Splitting narration into tokens and sentences. Used by the checker, the voice and the renderer alike. */

const CJK = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const TOKEN_RE = new RegExp(`[${CJK}]|[a-z0-9]+(?:'[a-z]+)?`, "g");
const CJK_RE = new RegExp(`[${CJK}]`);
const WIDE_RE = new RegExp(`[${CJK}\\u3000-\\u303f\\uff00-\\uffef]`, "g");

export const isCjk = (s: string) => CJK_RE.test(s);

/** Lower-cased words; every Chinese character is a token of its own. */
export function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[‘’]/g, "'").match(TOKEN_RE) ?? [];
}

/** Index of the first token of `phrase` in `haystack` at or after `from`, or -1. */
export function findPhrase(phrase: string[], haystack: string[], from = 0): number {
  if (!phrase.length) return -1;
  for (let i = from; i <= haystack.length - phrase.length; i++) {
    if (phrase.every((w, k) => haystack[i + k] === w)) return i;
  }
  return -1;
}

const SENTENCE_END = /([.!?。！？…]+["'”’)）]*)(\s+|$)|([。！？…]+["”’）]*)|\n+/g;
const CLAUSE_END = /([,;:，；：、—]+)(\s*)/g;

/** How long a piece of text takes to say, in rough syllables. */
export function spokenLength(s: string): number {
  return tokens(s).reduce((n, tok) => n + tokenLength(tok), 0);
}

export function tokenLength(tok: string): number {
  if (isCjk(tok)) return 1;
  if (/^\d+$/.test(tok)) return tok.length * 1.6;
  // vowel groups approximate syllables; a silent final "e" does not count
  const groups = tok.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function splitKeeping(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    out.push(text.slice(last, end));
    last = end;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Sentences short enough for the voice to say in one breath. A sentence longer than `max` syllables is
 * cut at its commas, and pieces are joined again while they fit.
 */
export function sentences(text: string, max = 55): string[] {
  const out: string[] = [];
  for (const sentence of splitKeeping(text, SENTENCE_END)) {
    if (spokenLength(sentence) <= max) {
      out.push(sentence);
      continue;
    }
    let cur = "";
    for (const clause of splitKeeping(sentence, CLAUSE_END)) {
      const joined = cur ? joinText(cur, clause) : clause;
      if (cur && spokenLength(joined) > max) {
        out.push(cur);
        cur = clause;
      } else cur = joined;
    }
    if (cur) out.push(cur);
  }
  // A piece of a word or two is rarely a sentence ("Dr.", "e.g.", "Yes!"), and the voice says very short
  // pieces badly. It joins the sentence before it; an opening one joins the sentence after.
  const merged: string[] = [];
  for (const piece of out) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && (spokenLength(piece) < MIN_SENTENCE || spokenLength(previous) < MIN_SENTENCE)) {
      merged[merged.length - 1] = joinText(previous, piece);
    } else merged.push(piece);
  }
  return merged;
}

const MIN_SENTENCE = 4;

/** Chinese is written without spaces; everything else gets one between pieces. */
export function joinText(a: string, b: string): string {
  const wide = (c: string) => c !== "" && c.replace(WIDE_RE, "") === "";
  return wide(a.slice(-1)) || wide(b.slice(0, 1)) ? a + b : `${a} ${b}`;
}

/** Width of a line of text in em, for layout estimates: Chinese is full width, handwritten Latin about 0.6. */
export function widthEm(line: string): number {
  const wide = line.match(WIDE_RE)?.length ?? 0;
  return wide + (line.length - wide) * 0.6;
}
