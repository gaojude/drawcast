import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { check } from "../src/format/check.ts";

const examples = path.join(import.meta.dirname, "../examples");
const box = (id, x, extra = {}) => ({ id, type: "rectangle", x, y: 100, width: 200, height: 100, ...extra });
const math = (id, tex, extra = {}) => ({ id, type: "math", x: 100, y: 100, tex, ...extra });
const script = (...steps) => ({ drawcast: 1, steps });
const report = (...steps) => check(script(...steps), examples);

test("the examples have no errors or warnings", async () => {
  for (const file of readdirSync(examples).filter((f) => f.endsWith(".json"))) {
    assert.deepEqual(await check(JSON.parse(readFileSync(path.join(examples, file), "utf8")), examples), { errors: [], warnings: [] }, file);
  }
});

test("the script in the guide is valid", async () => {
  const guide = readFileSync(path.join(import.meta.dirname, "../docs/format.md"), "utf8");
  const scripts = [...guide.matchAll(/```json\n(\{\n  "drawcast"[\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.deepEqual(await check(s, examples), { errors: [], warnings: [] });
});

test("the cover is a step of the script, or false", async () => {
  const steps = [{ say: "One box.", do: [{ add: box("a", 100) }] }, { say: "Another box.", do: [{ add: box("b", 700) }] }];
  for (const cover of [1, 2, false]) assert.deepEqual((await check({ drawcast: 1, cover, steps }, examples)).errors, [], String(cover));
  for (const cover of [0, 3, 1.5, true, "end"]) {
    const { errors } = await check({ drawcast: 1, cover, steps }, examples);
    assert.equal(errors.length, 1, String(cover));
    assert.match(errors[0], /"cover" must be the number of a step, 1 to 2, or false/);
  }
});

test("an `at` phrase must be spoken, and in order", async () => {
  const { errors } = await report({
    say: "The client calls the server.",
    do: [
      { at: "server", add: box("server", 700) },
      { at: "client", add: box("client", 100) },
      { at: "database", add: box("db", 400) },
    ],
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /step 1, action 2 \(add "client"\).*before the previous action's phrase/);
  assert.match(errors[1], /"database" is not in this step's "say"/);
});

test("references must be on the canvas at that moment", async () => {
  const { errors } = await report(
    { do: [{ add: box("a", 100) }, { add: { id: "ab", type: "arrow", from: "a", to: "b" } }] },
    { do: [{ remove: "a" }, { update: { id: "a", opacity: 50 } }, { add: box("a", 500) }] },
  );
  assert.match(errors[0], /to refers to "b", which is not on the canvas/);
  assert.match(errors[1], /id refers to "a"/);
  assert.match(errors[2], /the id "a" is already used/);
});

test("typos in property names and values are caught", async () => {
  const { errors } = await report({ do: [{ add: box("a", 100, { colour: "red", strokeColor: "red", fillStyle: "dots" }) }] });
  assert.match(errors[0], /unknown property "colour"/);
  assert.match(errors[1], /strokeColor must be a hex colour/);
  assert.match(errors[2], /fillStyle must be one of/);
});

test("a voice is a name", async () => {
  const withVoice = async (voice) => (await check({ ...script({ say: "Hello there." }), voice }, examples)).errors;
  assert.deepEqual(await withVoice("maple"), []);
  assert.match((await withVoice({ clip: "me.wav", transcript: "Hello." }))[0], /must be a voice name/);
});

test("layout problems are warnings", async () => {
  const { errors, warnings } = await report({
    do: [
      { add: box("a", 100) },
      { add: box("b", 250) },
      { add: box("inside", 110, { y: 110, width: 50, height: 50 }) },
      { add: box("low", 600, { y: 650 }) },
      { add: box("wordy", 900, { width: 120, height: 40, label: "a label that is far too long for this" }) },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /\(add "b"\): partly overlaps "a"/);
  assert.match(warnings[1], /\(add "low"\): extends past the canvas/);
  assert.match(warnings[2], /\(add "wordy"\): the label .* will not fit/);
});

test("captions claim the bottom of the canvas only when something is said", async () => {
  const low = { add: box("low", 100, { y: 560 }) };
  assert.equal((await report({ do: [low] })).warnings.length, 0);
  assert.match((await report({ say: "Look at this.", do: [low] })).warnings[0], /sits under the captions/);
});

test("a formula is typeset to be checked, and LaTeX it cannot typeset is an error", async () => {
  assert.deepEqual(await report({ do: [{ add: math("sum", "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}") }] }), { errors: [], warnings: [] });

  const { errors } = await report({
    do: [
      { add: math("typo", "\\fraq{a}{b}") },
      { add: math("open", "\\frac{a}{b") },
      // what JSON makes of "\theta" and "\nabla f": a tab and a line break
      { add: math("tab", "\theta") },
      { add: math("newline", "\nabla f") },
      { add: math("empty", "{}") },
      { add: { id: "none", type: "math", x: 0, y: 0 } },
    ],
  });
  assert.equal(errors.length, 6);
  assert.match(errors[0], /\(add "typo"\): the formula "\\\\fraq\{a\}\{b\}" could not be typeset: Undefined control sequence \\fraq/);
  assert.match(errors[1], /\(add "open"\).*Missing close brace/);
  assert.match(errors[2], /\(add "tab"\).*Write every backslash of the LaTeX twice/);
  assert.match(errors[3], /\(add "newline"\).*Write every backslash of the LaTeX twice/);
  assert.match(errors[4], /\(add "empty"\).*it draws nothing/);
  assert.match(errors[5], /\(add "none"\): needs "tex"/);
});

test("a formula is laid out at its real size", async () => {
  // 7.4 em wide and 2.8 em tall: at 40, about 297 by 110
  const sum = "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}";
  const { warnings } = await report({
    do: [
      { add: math("fits", sum, { x: 900, y: 100, fontSize: 40 }) },
      { add: math("wide", sum, { x: 1000, y: 300, fontSize: 40 }) },
      { add: math("centred", sum, { x: 1000, y: 500, fontSize: 40, textAlign: "center" }) },
      { add: box("under", 200, { y: 150, width: 100, height: 20 }) },
      { add: math("over", sum, { x: 250, y: 100, fontSize: 40 }) },
    ],
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /\(add "wide"\): extends past the canvas .* it spans x 1000 to 1297, y 300 to 410/);
  assert.match(warnings[1], /\(add "over"\): partly overlaps "under"/);
});

test("an update can replace a formula, and nothing else, with `tex`", async () => {
  const { errors, warnings } = await report({
    do: [
      { add: math("eq", "a^2", { x: 1100 }) },
      { add: box("a", 100) },
      { add: { id: "note", type: "text", x: 400, y: 400, text: "note" } },
      { update: { id: "eq", tex: "a^2 + b^2 = c^2 + d^2 + e^2 + f^2 + g^2" } },
      { update: { id: "eq", tex: "\\sqrt{" } },
      { update: { id: "eq", text: "c" } },
      { update: { id: "eq", width: 300 } },
      { update: { id: ["a", "note"], tex: "x" } },
    ],
  });
  assert.equal(errors.length, 5);
  assert.match(errors[0], /\(update "eq"\).*could not be typeset: Missing close brace/);
  assert.match(errors[1], /"text" can only replace the content of a text element; "eq" is a math, whose formula is replaced with "tex"/);
  assert.match(errors[2], /"eq" is a formula, which cannot be stretched/);
  assert.match(errors[3], /"tex" can only replace the formula of a math element; "a" is a rectangle/);
  assert.match(errors[4], /"note" is a text/);
  assert.deepEqual(warnings, []);
});

test("LaTeX outside a math element is a warning, and a price is not LaTeX", async () => {
  const label = async (text) => (await report({ do: [{ add: box("a", 100, { width: 600, label: text }) }] })).warnings;
  for (const tex of ["$\\alpha$", "rate \\alpha", "$x$ is the input", "x^{2}", "$O(n \\log n)$"]) assert.match((await label(tex))[0], /looks like LaTeX.*"math" element/, tex);
  for (const plain of ["rate α = 0.1", "from $5 to $10", "$5-$10", "C:\\temp\\new", "x^2 + y_1", "100%"]) assert.deepEqual(await label(plain), [], plain);

  const { warnings } = await report({
    say: "The loss is $x^2$ here.",
    do: [{ add: { id: "t", type: "text", x: 100, y: 100, text: "\\frac{1}{2}" } }, { update: { id: "t", text: "\\theta" } }],
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /step 1: "say" has LaTeX in it/);
  assert.match(warnings[1], /the text "\\\\frac\{1\}\{2\}" looks like LaTeX/);
  assert.match(warnings[2], /the text "\\\\theta" looks like LaTeX/);
});

test("centred text is measured from its middle", async () => {
  const title = { id: "title", type: "text", x: 640, y: 100, text: "A title of thirty characters ok", fontSize: 40 };
  // about 740 wide: from its left edge it runs off the canvas, from its middle it does not
  assert.match((await report({ do: [{ add: title }] })).warnings[0], /extends past the canvas/);
  assert.deepEqual((await report({ do: [{ add: { ...title, textAlign: "center" } }] })).warnings, []);
});
