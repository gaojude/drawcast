import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cacheDir, packageRoot } from "./paths.ts";
import { findBrowser } from "./render/browser.ts";
import { findFfmpeg } from "./render/encode.ts";
import { inspectVideo } from "./render/inspect.ts";
import { ScriptError, exportNarration, loadScript, parseSteps, renderSnapshot, renderVideo } from "./render/render.ts";

const HELP = `drawcast: turn a narrated Excalidraw script into a video

Usage
  drawcast guide [topic ...]          quick start, selected topics, or the full script reference
  drawcast check <script>             find problems in a script without rendering it
  drawcast narration export <script>  write a sentence request for an external TTS provider
  drawcast snapshot <script>          save the canvas as a PNG, to look at the layout
  drawcast render <script>            render the MP4 from the script and recorded audio
  drawcast inspect <video.mp4>        sample the encoded video to <video>.inspect.png
  drawcast setup                      download what rendering needs, and report what is installed

Options
  -o, --output <file>     where to write (default: the script's name with .mp4 or .png)
  --narration <file>      render, snapshot: use a narration result JSON and its recorded WAVs
  --no-captions           render, snapshot: leave the captions out
  --fps <n>               render: frames per second (default 30)
  --width <px>            output width (default 1.5 x the canvas for video, canvas width for a still,
                          encoded width for an inspected frame, or 512 per tile for a sheet)
  --step <n>              snapshot: the canvas as step n is done (every action finished). Several:
                          2,5,9 or 3-6 or all, a file each
                          inspect: encoded frames for those steps in a Drawcast MP4, up to 12 per sheet
  --sheet                 snapshot: the steps (default all) on one picture, in a grid
  --motion                inspect: sample movement between the opening and ending frames
  --at <seconds>          snapshot: the video at that moment, with pointer and captions
                          inspect: one full-size frame, or a sheet at up to 12 comma-separated times
  -h, --help, -v, --version

Downloaded browsers are kept in ${cacheDir()} (set DRAWCAST_HOME to move them).`;

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
      narration: { type: "string" },
      "no-captions": { type: "boolean" },
      fps: { type: "string" },
      width: { type: "string" },
      at: { type: "string" },
      step: { type: "string" },
      sheet: { type: "boolean" },
      motion: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, argument] = positionals;
  const exporting = command === "narration" && argument === "export";
  const file = exporting ? positionals[2] : argument;

  const version: string = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  if (values.version) return console.log(version), 0;
  if (values.help || !command) return console.log(HELP), command || values.help ? 0 : 1;

  const takesScript = ["check", "snapshot", "render"].includes(command);
  if (command === "narration" && !exporting) throw new Error("Usage: drawcast narration export <script> [-o request.json]");
  const maxArgs = exporting ? 3 : takesScript || command === "inspect" ? 2 : 1;
  if (command !== "guide" && positionals.length > maxArgs) throw new Error(`Unexpected argument for ${command}: ${positionals[maxArgs]}.`);
  const allowed = command === "render" || command === "snapshot"
    ? ["output", "width", "no-captions", "narration", ...(command === "snapshot" ? ["sheet", "at", "step"] : ["fps"])]
    : exporting ? ["output"]
    : command === "inspect" ? ["output", "at", "motion", "step", "width"] : [];
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

    case "setup": {
      const browser = await findBrowser(true, log, signal);
      signal.throwIfAborted();
      console.log(`browser       ${browser ?? "missing: install Chrome, Chromium or Edge"}`);
      const ffmpeg = findFfmpeg();
      console.log(`ffmpeg        ${ffmpeg ?? "missing: install ffmpeg, or reinstall drawcast with install scripts allowed"}`);
      return browser && ffmpeg ? 0 : 1;
    }

    case "inspect": {
      if (!file) throw new Error("Which MP4? Usage: drawcast inspect <video.mp4> [--step <n> | --at <seconds> | --motion] [-o <file>]");
      if (!existsSync(file)) throw new Error(`${file} does not exist.`);
      const requested = values.at?.trim().split(/\s*,\s*|\s+/).map(s => number(s, "at")!);
      const at = requested?.length === 1 ? requested[0] : requested;
      const stem = path.join(path.dirname(file), path.parse(file).name);
      const stepKind = /^\d+$/.test(values.step?.trim() ?? "") ? `.step${Number(values.step)}` : ".steps";
      const kind = values.step !== undefined ? stepKind : values.motion ? ".motion" : Array.isArray(at) ? ".times" : at === undefined ? "" : `.at${at}`;
      const output = values.output ?? `${stem}.inspect${kind}.png`;
      const { files, duration, frames, dimensions, audioCodec } = await inspectVideo(file, output, { at, signal, motion: values.motion, width: number(values.width, "width"), step: values.step });
      console.log([`${Number(duration.toFixed(3))} s`, dimensions, `${frames} frames`, `${Number((frames / duration).toFixed(3))} fps average`, audioCodec ? `${audioCodec} audio` : "no audio track"].filter(Boolean).join(", "));
      for (const { file, times, steps } of files) {
        const seconds = times.map(s => Number(s.toFixed(3)));
        const shows = steps ? steps.map((ns, i) => `step${ns.length === 1 ? "" : "s"} ${ns.join(", ")} at ${seconds[i]} s`).join("; ") : `encoded frames at ${seconds.join(", ")} s`;
        console.log(`${file} (${shows})`);
      }
      return 0;
    }

    case "narration":
      if (!file) throw new Error("Usage: drawcast narration export <script> [-o request.json]");
      {
        const loaded = await loadScript(file, signal);
        printReport(loaded.report);
        const output = values.output ?? withExtension(file, ".narration.request.json");
        await exportNarration(loaded, output);
        console.log(output);
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
      const renderOptions = {
        narration: values.narration,
        signal,
        captions: values["no-captions"] ? false : undefined,
      };
      if (command === "snapshot") {
        const sheet = values.sheet ?? false;
        const steps = values.step !== undefined ? parseSteps(values.step, loaded.script.steps.length) : sheet ? parseSteps("all", loaded.script.steps.length) : undefined;
        // each kind of still gets its own name, so that looking at one does not overwrite another
        const kind = sheet ? ".sheet" : values.at !== undefined ? `.at${values.at}` : steps?.length === 1 ? `.step${steps[0]}` : "";
        const output = values.output ?? withExtension(file, `${kind}.png`);
        const { files, timing } = await renderSnapshot(loaded, { output, at: number(values.at, "at"), steps, sheet, width, ...renderOptions, log });
        for (const f of files) console.log(`${f.file} (${f.shows})`);
        console.log(timing);
        return 0;
      }
      const output = values.output ?? withExtension(file, ".mp4");
      const started = performance.now();
      const { duration } = await renderVideo(loaded, {
        output,
        width,
        fps: number(values.fps, "fps") ?? 30,
        ...renderOptions,
        log,
      });
      const wall = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
      const totalMs = performance.now() - started;
      console.log(`${output} (${duration.toFixed(1)} s, rendered in ${wall(totalMs)})`);
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
