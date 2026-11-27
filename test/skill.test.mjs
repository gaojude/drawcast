import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

const guideFor = (...args) => execFileSync(process.execPath, [path.join(root, "src/cli.ts"), "guide", ...args], { encoding: "utf8" });

test("the guide starts with the version and preserves the full reference on demand", () => {
  const { version } = JSON.parse(read("package.json"));
  const guide = guideFor();
  assert.equal(guide.split("\n")[0], `drawcast ${version}`);
  assert.equal(guide.slice(guide.indexOf("\n") + 2), read("docs/guide.md"));
  assert.equal(guideFor("full"), `drawcast ${version}\n\n${read("docs/format.md")}`);
});

test("every advertised topic opens the corresponding section", () => {
  const topics = [...read("docs/guide.md").matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
  assert.ok(topics.includes("plots"));
  for (const topic of topics.filter((name) => name !== "full")) {
    assert.match(guideFor(topic), new RegExp(`^#{2,3} ${topic}$`, "im"));
  }
  assert.throws(() => guideFor("unknown"), /Unknown guide topic/);
});

test("one guide call prints the requested topics once and in order", () => {
  const combined = guideFor("math", "elements", "plots", "elements");
  assert.deepEqual([...combined.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["Math", "Elements", "Plots"]);
  assert.match(combined, /^### Style$/m);
  assert.match(combined, /\bfillStyle\b/);
  assert.doesNotMatch(guideFor("elements"), /^## (Math|Plots)$/m);
  assert.equal(guideFor("plots", "full", "elements"), guideFor("full"));
  assert.throws(() => guideFor("plots", "full", "unknown"), /Unknown guide topic "unknown"/);
});

test("the skill only points at the guide of the latest release", () => {
  const body = read("skills/drawcast/SKILL.md").split("---").slice(2).join("---");
  assert.match(body, /`npx -y drawcast@latest guide`/);
  // anything the guide says would go stale in an installed copy of the skill
  for (const detail of ["check", "snapshot", "render", "voice", "cover", "math"]) assert.doesNotMatch(body, new RegExp(`\\b${detail}\\b`), detail);
});

test("the plugin and the package have the same version", () => {
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).version, JSON.parse(read("package.json")).version);
});
