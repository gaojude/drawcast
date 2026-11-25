import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("the guide starts with the version it belongs to", () => {
  const { version } = JSON.parse(read("package.json"));
  const guide = execFileSync(process.execPath, [path.join(root, "src/cli.ts"), "guide"], { encoding: "utf8" });
  assert.equal(guide.split("\n")[0], `drawcast ${version}`);
  assert.equal(guide.slice(guide.indexOf("\n") + 2), read("docs/format.md"));
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
