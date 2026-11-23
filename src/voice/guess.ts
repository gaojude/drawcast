/**
 * A reading for an English-looking word that no dictionary has: a product name, a coinage.
 *
 * English spelling is too irregular for rules to get every word right, but they get most close enough
 * to recognise ("Kubernetes", "Redis", "Ubuntu"), and the alternative is saying the letters one by one.
 */

/** Tried in order at each position of the word; the first that matches is taken. */
const RULES: [letters: RegExp, phones: string][] = [
  // endings
  [/tion/y, "ʃ ə n"],
  [/sion/y, "ʒ ə n"],
  [/ture$/y, "t ʃ ɚ"],
  [/(?<=[^aeiouy])le$/y, "ə l"],
  [/(?<=[sxz]|ch|sh)es$/y, "ɪ z"],
  [/(?<=[aeiouy].*)e$/y, ""],

  // consonants
  [/tch|ch/y, "t ʃ"],
  [/sh/y, "ʃ"],
  [/th/y, "θ"],
  [/ph/y, "f"],
  [/wh/y, "w"],
  [/ck|cc(?![eiy])/y, "k"],
  [/(?<!^)ng(?=[aeiouy])/y, "ŋ ɡ"],
  [/(?<!^)ng/y, "ŋ"],
  [/^[gk]n/y, "n"],
  [/^wr/y, "ɹ"],
  [/qu/y, "k w"],
  [/^x/y, "z"],
  [/x/y, "k s"],
  [/c(?=[eiy])/y, "s"],
  [/c/y, "k"],
  [/(?<=[aeiouy])gh/y, ""],
  [/g(?=[eiy])|j/y, "d ʒ"],
  [/gg?h?/y, "ɡ"],
  [/y(?=[aeiou])/y, "j"],
  [/(?<=[aeiou])s(?=[aeiou])/y, "z"],
  [/([bdfklmnpstvz])\1?/y, "$1"],
  [/rr?/y, "ɹ"],
  [/[hw]/y, "$&"],

  // a vowel and r
  [/ear/y, "ɪ ɹ"],
  [/ar(?![aeiouy])/y, "ɑ ː ɹ"],
  [/or(?![aeiouy])/y, "ɔ ː ɹ"],
  [/[eiu]r(?![aeiouy])/y, "ɚ"],

  // two vowels
  [/ee|ea|ie(?!$)/y, "i ː"],
  [/oo|ue|ui/y, "u ː"],
  [/ow$|oa/y, "o ʊ"],
  [/ou|ow/y, "a ʊ"],
  [/ey$|ie$/y, "i"],
  [/ai|ay|ei|ey/y, "e ɪ"],
  [/au|aw/y, "ɔ ː"],
  [/oi|oy/y, "ɔ ɪ"],
  [/eu|ew/y, "j u ː"],
  [/i(?=[ao])/y, "i"],

  // a vowel made long by a final e: vite, base
  [/a(?=[^aeiouy]e$)/y, "e ɪ"],
  [/[iy](?=[^aeiouy]e$)/y, "a ɪ"],
  [/o(?=[^aeiouy]e$)/y, "o ʊ"],
  [/u(?=[^aeiouy]e$)/y, "u ː"],
  [/e(?=[^aeiouy]e$)/y, "i ː"],

  // a vowel at the end, or before one consonant and another vowel
  [/a$/y, "ə"],
  [/o$|o(?=[^aeiouy][aeiouy])/y, "o ʊ"],
  [/u$|u(?=[^aeiouy][aeiouy])/y, "u ː"],
  [/i$|(?<=[aeiou].*)y$/y, "i"],
  [/(?<=^[^aeiouy]+)y/y, "a ɪ"],

  [/a/y, "æ"],
  [/e/y, "ɛ"],
  [/[iy]/y, "ɪ"],
  [/o/y, "ɑ ː"],
  [/u/y, "ʌ"],
];

const VOWEL = /^[æɛɪɑʌəɚiueaoɔ]/;
/** Vowels that rarely carry the stress. */
const WEAK = new Set(["ə", "ɚ", "i", "ə l"]);

/** The phones of `word` (lower-case letters), space separated, or null if it has no vowel to say. */
export function guess(word: string): string | null {
  const parts: string[] = [];
  for (let at = 0; at < word.length; ) {
    let length = 1;
    for (const [letters, phones] of RULES) {
      letters.lastIndex = at;
      const match = letters.exec(word);
      if (!match) continue;
      const said = phones.replace("$1", match[1] ?? "").replace("$&", match[0]);
      if (said) parts.push(said);
      length = match[0].length;
      break;
    }
    at += length;
  }

  const syllables = parts.flatMap((p, i) => (VOWEL.test(p) ? [i] : []));
  if (!syllables.length) return null;
  // English stress cannot be read off the spelling. The first syllable of a short word and the one
  // before last of a long word is the commonest pattern.
  let stressed = syllables.length < 3 ? 0 : syllables.length - 2;
  while (stressed > 0 && WEAK.has(parts[syllables[stressed]])) stressed--;
  const at = syllables[stressed];
  parts[at] = `ˈ ${parts[at] === "ɚ" ? "ɜ ː" : parts[at]}`;
  return parts.join(" ");
}
