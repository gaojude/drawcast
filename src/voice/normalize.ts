/**
 * Makes narration sayable. The voice can say Chinese characters and the English words in its dictionary,
 * and nothing else. So digits and symbols are written out as words, and an English word the dictionary
 * lacks is given a pronunciation: built from words it has, or guessed from the spelling. Acronyms are
 * spelled out.
 */
import { isCjk } from "../shared/text.ts";
import { guess } from "./guess.ts";

export interface Lexicon {
  /** word -> its phones, space separated */
  get(word: string): string | undefined;
}

export interface Normalized {
  text: string;
  /** Dictionary entries for words made up along the way (`running` from `run`), as `word phones` lines. */
  entries: Map<string, string>;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ZH_DIGITS = "零一二三四五六七八九";

function englishInteger(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${englishInteger(n % 100)}` : ""}`;
  for (const [size, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= size) return `${englishInteger(Math.floor(n / size))} ${name}${n % size ? ` ${englishInteger(n % size)}` : ""}`;
  }
  return "";
}

/** Chinese reading of 0..9999, e.g. 1087 -> 一千零八十七. */
function chineseSection(n: number): string {
  let out = "";
  let gap = false;
  for (const [size, unit] of [[1000, "千"], [100, "百"], [10, "十"], [1, ""]] as const) {
    const d = Math.floor(n / size) % 10;
    if (!d) {
      gap = out !== "";
      continue;
    }
    out += (gap ? "零" : "") + ZH_DIGITS[d] + unit;
    gap = false;
  }
  return out;
}

function chineseInteger(n: number): string {
  if (n === 0) return "零";
  let out = "";
  for (const [size, unit] of [[1e8, "亿"], [1e4, "万"], [1, ""]] as const) {
    const section = Math.floor(n / size) % 10000;
    if (!section) continue;
    out += (out && section < 1000 ? "零" : "") + chineseSection(section) + unit;
  }
  // 一十二 is said 十二
  return out.replace(/^一十/, "十");
}

/** A number as it is read aloud. `raw` is digits with an optional fraction. */
function readNumber(raw: string, chinese: boolean, asYear: boolean): string {
  const [whole, fraction] = raw.split(".");
  const n = Number(whole);
  const digits = (s: string) => [...s].map((d) => (chinese ? ZH_DIGITS[Number(d)] : ONES[Number(d)])).join(chinese ? "" : " ");
  if (asYear || whole.length > 13 || (whole.length > 1 && whole.startsWith("0"))) return digits(whole) + (fraction ? (chinese ? "点" : " point ") + digits(fraction) : "");
  const integer = chinese ? chineseInteger(n) : englishInteger(n);
  if (!fraction) return integer;
  return chinese ? `${integer}点${digits(fraction)}` : `${integer} point ${digits(fraction)}`;
}

const SYMBOLS: Record<string, [english: string, chinese: string]> = {
  "%": ["percent", "百分号"],
  "&": ["and", "和"],
  "+": ["plus", "加"],
  "=": ["equals", "等于"],
  "@": ["at", "at"],
};

const VOICELESS = new Set(["p", "t", "k", "f", "θ"]);
const HISSING = new Set(["s", "z", "ʃ", "ʒ", "ʧ", "ʤ"]);

/** What -s adds after a sound: boxes, bakes, runs. */
const plural = (last: string) => (HISSING.has(last) ? "ᵻ z" : VOICELESS.has(last) ? "s" : "z");
/** What -ed adds: narrated, baked, played. */
const past = (last: string) => (last === "t" || last === "d" ? "ᵻ d" : VOICELESS.has(last) || HISSING.has(last) ? "t" : "d");

/** An ending and the sounds it adds, given the last sound of the word it is added to. */
const SUFFIXES: [suffix: string, phones: (last: string) => string][] = [
  ["'s", plural],
  ["s", plural],
  ["es", plural],
  ["ed", past],
  ["ing", () => "ɪ ŋ"],
  ["ly", () => "l i"],
  ["er", () => "ə ɹ"],
];

/** A pronunciation for a word the dictionary lacks, from the words it has. */
function derive(word: string, lexicon: Lexicon): string | null {
  for (const [suffix, phones] of SUFFIXES) {
    if (!word.endsWith(suffix) || word.length - suffix.length < 2) continue;
    const stem = word.slice(0, -suffix.length);
    // running -> run, baked -> bake
    for (const base of [stem, stem.replace(/(.)\1$/, "$1"), `${stem}e`]) {
      const known = lexicon.get(base);
      if (known) return `${known} ${phones(known.split(" ").at(-1)!)}`;
    }
  }
  // codebase -> code + base, readme -> read + me
  for (let i = word.length - 2; i >= 3; i--) {
    const head = lexicon.get(word.slice(0, i));
    const tail = head && lexicon.get(word.slice(i));
    if (tail) return `${head} ${tail}`;
  }
  return null;
}

/** Letter by letter. The dictionary has the letter names as `ltra` .. `ltrz`. */
const spell = (word: string) => [...word.replace(/[^a-z]/g, "")].map((c) => `ltr${c}`).join(" ");

export function normalize(text: string, lexicon: Lexicon): Normalized {
  const entries = new Map<string, string>();
  const chinese = isCjk(text);

  let out = text
    .replace(/[‘’]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    // a percentage is read "百分之五" in Chinese
    .replace(/(\d+(?:\.\d+)?)%/g, (_, n) => (chinese ? `百分之${readNumber(n, true, false)}` : `${readNumber(n, false, false)} percent`))
    .replace(/(\d+(?:\.\d+)?)(年)?/g, (_, n: string, year?: string) => {
      const asYear = !n.includes(".") && n.length === 4 && (!!year || (!chinese && /^(1[5-9]|20)\d\d$/.test(n)));
      const said = !chinese && asYear ? englishYear(n) : readNumber(n, chinese, asYear);
      return chinese ? said + (year ?? "") : ` ${said} `;
    })
    .replace(/[%&+=@]/g, (c) => ` ${SYMBOLS[c][chinese ? 1 : 0]} `);

  // getUserName -> get User Name, so each part can be looked up
  out = out.replace(/([a-z])([A-Z])/g, "$1 $2");

  out = out.replace(/[A-Za-z]+(?:'[A-Za-z]+)*/g, (raw) => {
    const word = raw.toLowerCase();
    if (lexicon.get(word) && !(raw.length > 1 && raw === raw.toUpperCase() && raw.length <= 3)) return word;
    // an acronym, or letters with no vowel to say: read it letter by letter
    if ((raw === raw.toUpperCase() && raw.length <= 5) || !/[aeiouy]/.test(word)) return spell(word);
    if (lexicon.get(word)) return word;
    const phones = derive(word, lexicon) ?? guess(word);
    if (!phones) return spell(word);
    entries.set(word, phones);
    return word;
  });

  return { text: out.replace(/\s+/g, " ").trim(), entries };
}

/** 1987 -> nineteen eighty seven, 2005 -> two thousand five. */
function englishYear(n: string): string {
  const [century, rest] = [Number(n.slice(0, 2)), Number(n.slice(2))];
  if (rest < 10) return century % 10 === 0 ? `${englishInteger(Number(n))}` : `${englishInteger(century)} oh ${ONES[rest]}`;
  return `${englishInteger(century)} ${englishInteger(rest)}`;
}
