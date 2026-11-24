import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { cacheDir, packageRoot } from "./paths.ts";
import { findBrowser } from "./render/browser.ts";
import { findFfmpeg } from "./render/encode.ts";
import { ScriptError, loadScript, renderSnapshot, renderVideo } from "./render/render.ts";
import { ensureModels, modelsDir, modelsInstalled } from "./voice/models.ts";
import { EDGE_PREFIX, EDGE_VOICES, findEdgeTts } from "./voice/edge.ts";
import { builtInVoices } from "./voice/voice.ts";

const HELP = `drawcast: turn a narrated Excalidraw script into a video

Usage
  drawcast guide                      how to write a script (the file format, with examples)
  drawcast check <script>             find problems in a script without rendering it
  drawcast snapshot <script>          save one moment as a PNG, to look at the layout
  drawcast render <script>            speak the narration and render the MP4
  drawcast voices                     list the voices
  drawcast setup                      download what rendering needs, and report what is installed
  drawcast skill [--install]          where the agent skill is; --install copies it to ~/.claude/skills

Options
  -o, --output <file>     where to write (default: the script's name with .mp4 or .png)
  --voice <name>          render: a voice from "drawcast voices", instead of the script's
  --speed <n>             render: speaking rate, 1 = normal
  --no-captions           render: leave the captions out
  --fps <n>               render: frames per second (default 30)
  --width <px>            render, snapshot: output width (default: 1.5 x the canvas, so 1920)
  --tts-command <cmd>     render: speak with your own program. It gets one sentence on stdin
                          and must write a WAV file to the path in $DRAWCAST_OUT.
  --at <seconds>          snapshot: the moment to capture (default: the end)
  --step <n>              snapshot: capture the canvas as step n ends
  -h, --help, -v, --version

Files are kept in ${cacheDir()} (set DRAWCAST_HOME to move them).`;

const log = (line: string) => process.stderr.write(`${line}\n`);

function printReport(report: { errors: string[]; warnings: string[] }) {
  for (const e of report.errors) log(`error    ${e}`);
  for (const w of report.warnings) log(`warning  ${w}`);
}

const withExtension = (file: string, ext: string) => path.join(path.dirname(file), `${path.basename(file).replace(/(\.drawcast)?\.json$/i, "")}${ext}`);

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number (got "${value}").`);
  return n;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      voice: { type: "string" },
      speed: { type: "string" },
      "no-captions": { type: "boolean" },
      fps: { type: "string" },
      width: { type: "string" },
      "tts-command": { type: "string" },
      at: { type: "string" },
      step: { type: "string" },
      install: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, file] = positionals;

  if (values.version) return console.log(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version), 0;
  if (values.help || !command) return console.log(HELP), command || values.help ? 0 : 1;

  switch (command) {
    case "guide":
      process.stdout.write(readFileSync(path.join(packageRoot, "docs", "format.md"), "utf8"));
      return 0;

    case "voices": {
      const width = Math.max(...EDGE_VOICES.map((v) => EDGE_PREFIX.length + v.name.length));
      for (const [name, v] of Object.entries(builtInVoices())) console.log(`${name.padEnd(width)}  ${v.language}  ${v.description}`);
      console.log(`\nLeft unset, a script gets the first voice of its language. A script can also bring its own:\n  "voice": { "clip": "me.wav", "transcript": "the words spoken in me.wav" }`);
      console.log(`\nOnline voices, from Microsoft. They sound more natural, send the narration to Microsoft, and need\nthe edge-tts program (${findEdgeTts() ? "installed" : 'not found: "pipx install edge-tts" or "uv tool install edge-tts"'}):`);
      for (const v of EDGE_VOICES) console.log(`${(EDGE_PREFIX + v.name).padEnd(width)}  ${v.language}  ${v.description}`);
      console.log(`"edge-tts --list-voices" lists the rest; put "${EDGE_PREFIX}" in front of a name.`);
      return 0;
    }

    case "setup": {
      await ensureModels(log);
      const browser = await findBrowser(true, log);
      console.log(`speech model  ${modelsInstalled() ? modelsDir() : "missing"}`);
      console.log(`browser       ${browser ?? "missing: install Chrome, Chromium or Edge"}`);
      console.log(`ffmpeg        ${findFfmpeg() ?? "missing: install ffmpeg, or reinstall drawcast with install scripts allowed"}`);
      return browser && findFfmpeg() ? 0 : 1;
    }

    case "skill": {
      const skill = path.join(packageRoot, "skills", "drawcast");
      if (!values.install) return console.log(skill), 0;
      const target = path.join(os.homedir(), ".claude", "skills", "drawcast");
      await mkdir(path.dirname(target), { recursive: true });
      await cp(skill, target, { recursive: true });
      console.log(`Installed the skill to ${target}`);
      return 0;
    }

    case "check":
    case "snapshot":
    case "render": {
      if (!file) throw new Error(`Which script? Usage: drawcast ${command} <script>`);
      if (!existsSync(file)) throw new Error(`${file} does not exist.`);
      const loaded = await loadScript(file);
      printReport(loaded.report);
      const width = number(values.width, "width");

      if (command === "check") {
        console.log(loaded.report.warnings.length ? `${loaded.report.warnings.length} warning(s), no errors.` : "No problems found.");
        return 0;
      }
      if (command === "snapshot") {
        const output = values.output ?? withExtension(file, ".png");
        const { at } = await renderSnapshot(loaded, { output, at: number(values.at, "at"), step: number(values.step, "step"), width, log });
        console.log(`${output} (the canvas at ${at.toFixed(1)} s)`);
        return 0;
      }
      const output = values.output ?? withExtension(file, ".mp4");
      const started = Date.now();
      const { duration } = await renderVideo(loaded, {
        output,
        width,
        fps: number(values.fps, "fps") ?? 30,
        voice: values.voice,
        speed: number(values.speed, "speed"),
        captions: values["no-captions"] ? false : undefined,
        ttsCommand: values["tts-command"],
        log,
      });
      console.log(`${output} (${duration.toFixed(1)} s, rendered in ${((Date.now() - started) / 1000).toFixed(0)} s)`);
      return 0;
    }

    default:
      throw new Error(`Unknown command "${command}". Run drawcast --help.`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ScriptError) {
      printReport(e.report);
      log(`\n${e.report.errors.length} error(s). Run "drawcast guide" for the format.`);
    } else log(`drawcast: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
