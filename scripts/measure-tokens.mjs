// Measures what a script costs a model to write, in tokens, and what the same finished canvas costs
// as the scene file Excalidraw saves. The numbers in the README come from here.
//
//   npm run build && node scripts/measure-tokens.mjs examples/dns.drawcast.json [more scripts]
//
// Tokens are counted with o200k_base, the tokenizer of OpenAI's current models, because it runs
// offline. Other models split text a little differently; the ratios hold.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { openPlayer } from "../src/render/player.ts";
import { loadScript, typesetFormulas } from "../src/render/render.ts";
import { estimateNarration } from "../src/voice/narrate.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const count = (text) => encode(text).length;
const row = (name, tokens, note = "") => console.log(`  ${name.padEnd(46)} ${String(tokens).padStart(7)} tokens  ${note}`);

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, "utf8");
  const { script } = await loadScript(file);
  const narration = script.steps.map((s) => s.say ?? "").join(" ");

  const player = await openPlayer({ script, images: {}, math: await typesetFormulas(script), output: { width: 1920, height: 1080 } }, () => {});
  const { duration } = await player.load(estimateNarration(script).steps);
  const elements = await player.elements(duration);
  await player.close();
  // minified, which is the cheapest way to write it
  const scene = JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });

  console.log(`${file}  (${script.steps.length} steps, ${elements.length} elements, ${Buffer.byteLength(text)} bytes)`);
  row("the script, as written", count(text), "what it says, what it draws, and when");
  row("the script, minified", count(JSON.stringify(script)));
  row("its narration alone", count(narration));
  row("the finished canvas as an Excalidraw scene", count(scene), "minified; no narration, no timing");
  console.log();
}

console.log("What an agent reads");
row("skills/drawcast/SKILL.md", count(readFileSync(path.join(root, "skills/drawcast/SKILL.md"), "utf8")), "loaded when the skill is used");
row("drawcast guide (docs/format.md)", count(readFileSync(path.join(root, "docs/format.md"), "utf8")), "read once per task");
