/**
 * A reading for an English-looking word that no dictionary has: a product name, a coinage.
 *
 * English spelling is too irregular for rules to get every word right, but they get most close enough
 * to recognise ("Kubernetes", "Redis", "Ubuntu"), and the alternative is saying the letters one by one.
 *
 * The phonemes are written the way the voice's dictionary writes them: one capital letter for a
 * diphthong (A as in day, I as in my, O as in go, W as in now, Y as in boy), ʧ and ʤ for ch and j.
 */

/** Tried in order at each position of the word; the first that matches is taken. */
const RULES: [letters: RegExp, phones: string][] = [
  // endings
  [/tion/y, "ʃ ə n"],
  [/sion/y, "ʒ ə n"],
  [/ture$/y, "ʧ ə ɹ"],
  [/(?<=[^aeiouy])le$/y, "ᵊ l"],
  [/(?<=[sxz]|ch|sh)es$/y, "ᵻ z"],
  [/(?<=[aeiouy].*)e$/y, ""],

  // consonants
  [/tch|ch/y, "ʧ"],
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
  [/g(?=[eiy])|j/y, "ʤ"],
  [/gg?h?/y, "ɡ"],
  [/y(?=[aeiou])/y, "j"],
  [/(?<=[aeiou])s(?=[aeiou])/y, "z"],
  [/([bdfklmnpstvz])\1?/y, "$1"],
  [/rr?/y, "ɹ"],
  [/[hw]/y, "$&"],

  // a vowel and r
  [/ear/y, "ɪ ɹ"],
  [/ar(?![aeiouy])/y, "ɑ ɹ"],
  [/or(?![aeiouy])/y, "ɔ ɹ"],
  [/[eiu]r(?![aeiouy])/y, "ə ɹ"],

  // two vowels
  [/ee|ea|ie(?!$)/y, "i"],
  [/oo|ue|ui/y, "u"],
  [/ow$|oa/y, "O"],
  [/ou|ow/y, "W"],
  [/ey$|ie$/y, "i"],
  [/ai|ay|ei|ey/y, "A"],
  [/au|aw/y, "ɔ"],
  [/oi|oy/y, "Y"],
  [/eu|ew/y, "j u"],
  [/i(?=[ao])/y, "i"],

  // a vowel made long by a final e: vite, base
  [/a(?=[^aeiouy]e$)/y, "A"],
  [/[iy](?=[^aeiouy]e$)/y, "I"],
  [/o(?=[^aeiouy]e$)/y, "O"],
  [/u(?=[^aeiouy]e$)/y, "u"],
  [/e(?=[^aeiouy]e$)/y, "i"],

  // a vowel at the end, or before one consonant and another vowel
  [/a$/y, "ə"],
  [/o$|o(?=[^aeiouy][aeiouy])/y, "O"],
  [/u$|u(?=[^aeiouy][aeiouy])/y, "u"],
  [/i$|(?<=[aeiou].*)y$/y, "i"],
  [/(?<=^[^aeiouy]+)y/y, "I"],

  [/a/y, "æ"],
  [/e/y, "ɛ"],
  [/[iy]/y, "ɪ"],
  [/o/y, "ɑ"],
  [/u/y, "ʌ"],
];

const VOWEL = /^[AIOWYæɛɪɑʌəiuɔᵊ]/;
/** Vowels that rarely carry the stress. */
const WEAK = new Set(["ə", "ə ɹ", "i", "ᵊ l"]);

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
  // a stressed "er" is the vowel of "bird"
  parts[at] = `ˈ ${parts[at] === "ə ɹ" ? "ɜ ɹ" : parts[at]}`;
  return parts.join(" ");
}
