import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { check } from "../src/format/check.ts";

const examples = path.join(import.meta.dirname, "../examples");
const box = (id, x, extra = {}) => ({ id, type: "rectangle", x, y: 100, width: 200, height: 100, ...extra });
const script = (...steps) => ({ drawcast: 1, steps });
const report = (...steps) => check(script(...steps), examples);

test("the examples have no errors or warnings", () => {
  for (const file of readdirSync(examples).filter((f) => f.endsWith(".json"))) {
    assert.deepEqual(check(JSON.parse(readFileSync(path.join(examples, file), "utf8")), examples), { errors: [], warnings: [] }, file);
  }
});

test("the script in the guide is valid", () => {
  const guide = readFileSync(path.join(import.meta.dirname, "../docs/format.md"), "utf8");
  const scripts = [...guide.matchAll(/```json\n(\{\n  "drawcast"[\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.deepEqual(check(s, examples), { errors: [], warnings: [] });
});

test("an `at` phrase must be spoken, and in order", () => {
  const { errors } = report({
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

test("references must be on the canvas at that moment", () => {
  const { errors } = report(
    { do: [{ add: box("a", 100) }, { add: { id: "ab", type: "arrow", from: "a", to: "b" } }] },
    { do: [{ remove: "a" }, { update: { id: "a", opacity: 50 } }, { add: box("a", 500) }] },
  );
  assert.match(errors[0], /to refers to "b", which is not on the canvas/);
  assert.match(errors[1], /id refers to "a"/);
  assert.match(errors[2], /the id "a" is already used/);
});

test("typos in property names and values are caught", () => {
  const { errors } = report({ do: [{ add: box("a", 100, { colour: "red", strokeColor: "red", fillStyle: "dots" }) }] });
  assert.match(errors[0], /unknown property "colour"/);
  assert.match(errors[1], /strokeColor must be a hex colour/);
  assert.match(errors[2], /fillStyle must be one of/);
});

test("a voice is a name", () => {
  const withVoice = (voice) => check({ ...script({ say: "Hello there." }), voice }, examples).errors;
  assert.deepEqual(withVoice("maple"), []);
  assert.match(withVoice({ clip: "me.wav", transcript: "Hello." })[0], /must be a voice name/);
});

test("layout problems are warnings", () => {
  const { errors, warnings } = report({
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

test("captions claim the bottom of the canvas only when something is said", () => {
  const low = { add: box("low", 100, { y: 560 }) };
  assert.equal(report({ do: [low] }).warnings.length, 0);
  assert.match(report({ say: "Look at this.", do: [low] }).warnings[0], /sits under the captions/);
});
