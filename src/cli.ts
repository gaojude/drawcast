import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cacheDir, packageRoot } from "./paths.ts";
import { findBrowser } from "./render/browser.ts";
import { findFfmpeg } from "./render/encode.ts";
import { inspectVideo } from "./render/inspect.ts";
import { ScriptError, loadScript, parseSteps, renderSnapshot, renderVideo } from "./render/render.ts";
import { ensureModels, modelsDir, modelsInstalled } from "./voice/models.ts";
import { EDGE_PREFIX, EDGE_VOICES, edgeTtsStatus } from "./voice/edge.ts";
import { SPEAKERS, builtInVoices } from "./voice/voice.ts";

const HELP = `drawcast: turn a narrated Excalidraw script into a video

Usage
  drawcast guide [topic ...]          quick start, selected topics, or the full script reference
  drawcast check <script>             find problems in a script without rendering it
  drawcast snapshot <script>          save the canvas as a PNG, to look at the layout
  drawcast render <script>            speak the narration and render the MP4
  drawcast inspect <video.mp4>        sample the encoded video to <video>.inspect.png
  drawcast voices                     list the voices
  drawcast setup                      download what rendering needs, and report what is installed

Options
  -o, --output <file>     where to write (default: the script's name with .mp4 or .png)
  --voice <name>          render, snapshot: a voice from "drawcast voices", instead of the script's
  --speed <n>             render, snapshot: speaking rate from 0.5 to 2, 1 = normal
  --no-captions           render, snapshot: leave the captions out
  --fps <n>               render: frames per second (default 30)
  --width <px>            output width (default 1.5 x the canvas for video, canvas width for a still,
                          encoded width for an inspected frame, or 512 per tile for a sheet)
  --tts-command <cmd>     render: speak with your own program. It gets one sentence on stdin
                          and must write a WAV file to the path in $DRAWCAST_OUT. With snapshot,
                          use cached timing from that command.
  --step <n>              snapshot: the canvas as step n is done (every action finished). Several:
                          2,5,9 or 3-6 or all, a file each
  --sheet                 snapshot: the steps (default all) on one picture, in a grid
  --motion                inspect: sample movement between the opening and ending frames
  --at <seconds>          snapshot: the video at that moment, with pointer and captions
                          inspect: one full-size frame, or a sheet at up to 12 comma-separated times
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
  if (!value.trim() || !Number.isFinite(n)) throw new Error(`--${name} must be a number (got "${value}").`);
  return n;
}

async function main(signal: AbortSignal): Promise<number> {
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
      motion: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, file] = positionals;

  const version: string = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  if (values.version) return console.log(version), 0;
  if (values.help || !command) return console.log(HELP), command || values.help ? 0 : 1;

  const takesScript = ["check", "snapshot", "render"].includes(command);
  const maxArgs = takesScript || command === "inspect" ? 2 : 1;
  if (command !== "guide" && positionals.length > maxArgs) throw new Error(`Unexpected argument for ${command}: ${positionals[maxArgs]}.`);
  const allowed = command === "render" || command === "snapshot"
    ? ["output", "width", "voice", "speed", "no-captions", "tts-command", ...(command === "snapshot" ? ["sheet", "at", "step"] : ["fps"])]
    : command === "inspect" ? ["output", "at", "motion", "width"] : [];
  for (const [option, value] of Object.entries(values)) {
    if (!allowed.includes(option)) throw new Error(`--${option} does not apply to ${command}.`);
    if (typeof value === "string" && !value.trim()) throw new Error(`--${option} needs a nonempty value.`);
  }

  switch (command) {
    case "guide": {
      const topics = ["script", "pie", "plots", "math", "elements", "actions", "layout", "narration", "full"];
      const requested = new Set(positionals.slice(1));
      for (const topic of requested) {
        if (!topics.includes(topic)) throw new Error(`Unknown guide topic "${topic}". Choose from ${topics.join(", ")}.`);
      }
      let guide = readFileSync(path.join(packageRoot, "docs", requested.size ? "format.md" : "guide.md"), "utf8");
      if (requested.size && !requested.has("full")) {
        const sections = guide.replace(/\r\n/g, "\n").split(/(?=^## )/m);
        guide = [...requested].map((topic) => {
          const section = sections.find((s) => s.slice(0, s.indexOf("\n")).toLowerCase() === `## ${topic}`);
          if (!section) throw new Error(`Guide section "${topic}" is missing.`);
          return section.trimEnd();
        }).join("\n\n") + "\n";
      }
      process.stdout.write(`drawcast ${version}\n\n${guide}`);
      return 0;
    }

    case "voices": {
      const width = Math.max(...EDGE_VOICES.map((v) => EDGE_PREFIX.length + v.name.length));
      for (const [name, v] of Object.entries(builtInVoices())) console.log(`${name.padEnd(width)}  ${v.language}  ${v.description}`);
      console.log(`\nThese run on this machine. The model has ${SPEAKERS.length} speakers and these are names for four of them;\nany other works by its own name, such as zf_001 or zm_100:\n  https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/main/voices`);
      console.log(`\nOnline voices send the narration to Microsoft and need the edge-tts program.\nedge-tts: ${edgeTtsStatus().description}\nLeft unset, a script gets the first online voice of its language, or the first built-in one if that\ncannot be had:`);
      for (const v of EDGE_VOICES) console.log(`${(EDGE_PREFIX + v.name).padEnd(width)}  ${v.language}  ${v.description}`);
      console.log(`"edge-tts --list-voices" lists the rest; put "${EDGE_PREFIX}" in front of a name.`);
      return 0;
    }

    case "setup": {
      await ensureModels(log, signal);
      const browser = await findBrowser(true, log, signal);
      signal.throwIfAborted();
      console.log(`speech model  ${modelsInstalled() ? modelsDir() : "missing"}`);
      console.log(`browser       ${browser ?? "missing: install Chrome, Chromium or Edge"}`);
      const ffmpeg = findFfmpeg();
      console.log(`ffmpeg        ${ffmpeg ?? "missing: install ffmpeg, or reinstall drawcast with install scripts allowed"}`);
      // optional: without it a script left without a voice is spoken by the built-in one
      console.log(`edge-tts      ${edgeTtsStatus().description} (needed for online voices)`);
      return browser && ffmpeg ? 0 : 1;
    }

    case "inspect": {
      if (!file) throw new Error("Which MP4? Usage: drawcast inspect <video.mp4> [--at <seconds>] [-o <file>]");
      if (!existsSync(file)) throw new Error(`${file} does not exist.`);
      const requested = values.at?.trim().split(/\s*,\s*|\s+/).map(s => number(s, "at")!);
      const at = requested?.length === 1 ? requested[0] : requested;
      const stem = path.join(path.dirname(file), path.parse(file).name);
      const kind = values.motion ? ".motion" : Array.isArray(at) ? ".times" : at === undefined ? "" : `.at${at}`;
      const output = values.output ?? `${stem}.inspect${kind}.png`;
      const { times, duration, frames, dimensions, audioCodec } = await inspectVideo(file, output, at, signal, values.motion, number(values.width, "width"));
      console.log([`${Number(duration.toFixed(3))} s`, dimensions, `${frames} frames`, `${Number((frames / duration).toFixed(3))} fps average`, audioCodec ? `${audioCodec} audio` : "no audio track"].filter(Boolean).join(", "));
      console.log(`${output} (encoded frames at ${times.map((s) => Number(s.toFixed(3))).join(", ")} s)`);
      return 0;
    }

    case "check":
    case "snapshot":
    case "render": {
      if (!file) throw new Error(`Which script? Usage: drawcast ${command} <script>`);
      if (!existsSync(file)) throw new Error(`${file} does not exist.`);
      if (values.output !== undefined && path.relative(file, values.output) === "") throw new Error("Choose an output file different from the input script.");
      const loaded = await loadScript(file, signal);
      printReport(loaded.report);
      const width = number(values.width, "width");

      if (command === "check") {
        console.log(loaded.report.warnings.length ? `${loaded.report.warnings.length} warning(s), no errors.` : "No problems found.");
        return 0;
      }
      const speech = {
        signal,
        voice: values.voice,
        speed: number(values.speed, "speed"),
        captions: values["no-captions"] ? false : undefined,
        ttsCommand: values["tts-command"],
      };
      if (command === "snapshot") {
        const sheet = values.sheet ?? false;
        const steps = values.step !== undefined ? parseSteps(values.step, loaded.script.steps.length) : sheet ? parseSteps("all", loaded.script.steps.length) : undefined;
        // each kind of still gets its own name, so that looking at one does not overwrite another
        const kind = sheet ? ".sheet" : values.at !== undefined ? `.at${values.at}` : steps?.length === 1 ? `.step${steps[0]}` : "";
        const output = values.output ?? withExtension(file, `${kind}.png`);
        const { files, timing } = await renderSnapshot(loaded, { output, at: number(values.at, "at"), steps, sheet, width, ...speech, log });
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
        ...speech,
        log,
      });
      console.log(`${output} (${duration.toFixed(1)} s, rendered in ${((Date.now() - started) / 1000).toFixed(0)} s)`);
      return 0;
    }

    default:
      throw new Error(`Unknown command "${command}". Run drawcast --help.`);
  }
}

const controller = new AbortController();
let interrupted = 0;
const stop = (signal: NodeJS.Signals) => {
  if (controller.signal.aborted) return;
  interrupted = signal === "SIGINT" ? 130 : 143;
  controller.abort(new Error(`Interrupted by ${signal}.`));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
main(controller.signal).then(
  (code) => { process.exitCode = interrupted || code; },
  (e) => {
    if (interrupted) e = controller.signal.reason;
    if (e instanceof ScriptError) {
      printReport(e.report);
      log(`\n${e.report.errors.length} error(s). Run "drawcast guide" for the format.`);
    } else log(`drawcast: ${e instanceof Error ? e.message : e}`);
    process.exitCode = interrupted || 1;
  },
).finally(() => {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
});
