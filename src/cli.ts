import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cacheDir, packageRoot } from "./paths.ts";
import { findBrowser } from "./render/browser.ts";
import { findFfmpeg } from "./render/encode.ts";
import { ScriptError, loadScript, parseSteps, renderSnapshot, renderVideo } from "./render/render.ts";
import { ensureModels, modelsDir, modelsInstalled } from "./voice/models.ts";
import { EDGE_PREFIX, EDGE_VOICES, findEdgeTts } from "./voice/edge.ts";
import { SPEAKERS, builtInVoices } from "./voice/voice.ts";

const HELP = `drawcast: turn a narrated Excalidraw script into a video

Usage
  drawcast guide                      how to write a script (the file format, with examples)
  drawcast check <script>             find problems in a script without rendering it
  drawcast snapshot <script>          save the canvas as a PNG, to look at the layout
  drawcast render <script>            speak the narration and render the MP4
  drawcast voices                     list the voices
  drawcast setup                      download what rendering needs, and report what is installed

Options
  -o, --output <file>     where to write (default: the script's name with .mp4 or .png)
  --voice <name>          render, snapshot: a voice from "drawcast voices", instead of the script's
  --speed <n>             render: speaking rate, 1 = normal
  --no-captions           render: leave the captions out
  --fps <n>               render: frames per second (default 30)
  --width <px>            output width (render: 1.5 x the canvas, so 1920; snapshot: the canvas, 1280)
  --tts-command <cmd>     render: speak with your own program. It gets one sentence on stdin
                          and must write a WAV file to the path in $DRAWCAST_OUT.
  --step <n>              snapshot: the canvas as step n is done (every action finished). Several:
                          2,5,9 or 3-6 or all, a file each
  --sheet                 snapshot: the steps (default all) on one picture, in a grid
  --at <seconds>          snapshot: the video at that moment, with pointer and captions
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
      sheet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, file] = positionals;

  const version: string = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  if (values.version) return console.log(version), 0;
  if (values.help || !command) return console.log(HELP), command || values.help ? 0 : 1;

  switch (command) {
    case "guide":
      // The version comes first: the guide tells an agent to compare it with `drawcast --version`.
      process.stdout.write(`drawcast ${version}\n\n${readFileSync(path.join(packageRoot, "docs", "format.md"), "utf8")}`);
      return 0;

    case "voices": {
      const width = Math.max(...EDGE_VOICES.map((v) => EDGE_PREFIX.length + v.name.length));
      for (const [name, v] of Object.entries(builtInVoices())) console.log(`${name.padEnd(width)}  ${v.language}  ${v.description}`);
      console.log(`\nThese run on this machine. The model has ${SPEAKERS.length} speakers and these are names for four of them;\nany other works by its own name, such as zf_001 or zm_100:\n  https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/main/voices`);
      console.log(`\nOnline voices, from Microsoft. They sound more natural, send the narration to Microsoft, and need\nthe edge-tts program (${findEdgeTts() ? "installed" : 'not found: "pipx install edge-tts" or "uv tool install edge-tts"'}).\nLeft unset, a script gets the first online voice of its language, or the first built-in one if that\ncannot be had:`);
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
      // optional: without it a script left without a voice is spoken by the built-in one
      console.log(`edge-tts      ${findEdgeTts() ?? 'not found (optional: the online voices need it; "pipx install edge-tts" or "uv tool install edge-tts")'}`);
      return browser && findFfmpeg() ? 0 : 1;
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
        const sheet = values.sheet ?? false;
        const steps = values.step !== undefined ? parseSteps(values.step, loaded.script.steps.length) : sheet ? parseSteps("all", loaded.script.steps.length) : undefined;
        // each kind of still gets its own name, so that looking at one does not overwrite another
        const kind = sheet ? ".sheet" : values.at !== undefined ? `.at${values.at}` : steps?.length === 1 ? `.step${steps[0]}` : "";
        const output = values.output ?? withExtension(file, `${kind}.png`);
        const { files, timing } = await renderSnapshot(loaded, { output, at: number(values.at, "at"), steps, sheet, width, voice: values.voice, log });
        for (const f of files) console.log(`${f.file} (${f.shows})`);
        console.log(timing);
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
