import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cacheDir, packageRoot } from "./paths.ts";
import { findBrowser } from "./render/browser.ts";
import { findFfmpeg } from "./render/encode.ts";
import { inspectVideo } from "./render/inspect.ts";
import { ScriptError, loadScript, parseSteps, renderSnapshot, renderVideo } from "./render/render.ts";
import { ensureModels, modelsDir, modelsInstalled } from "./voice/models.ts";
import { MINIMAX_MODEL, MINIMAX_PREFIX, MINIMAX_VOICES, minimaxKeyStatus, removeMinimaxKey, saveMinimaxKey } from "./voice/minimax.ts";
import { SPEAKERS, builtInVoices } from "./voice/voice.ts";

const HELP = `drawcast: turn a narrated Excalidraw script into a video

Usage
  drawcast guide [topic ...]          quick start, selected topics, or the full script reference
  drawcast check <script>             find problems in a script without rendering it
  drawcast snapshot <script>          save the canvas as a PNG, to look at the layout
  drawcast render <script>            speak the narration and render the MP4
  drawcast inspect <video.mp4>        sample the encoded video to <video>.inspect.png
  drawcast voices                     list the voices
  drawcast key minimax [--remove]     save the API key for MiniMax's paid voices, typed or pasted
                                      here and never shown, or remove the saved one
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
                          inspect: encoded frames for those steps in a Drawcast MP4, up to 12 per sheet
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

/**
 * Reads a secret: typed or pasted at a terminal without being shown, or piped in
 * (`Get-Clipboard | drawcast key minimax`, `pbpaste | drawcast key minimax`).
 */
async function readSecret(prompt: string, signal: AbortSignal): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      signal.removeEventListener("abort", onAbort);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    // in raw mode Ctrl+C arrives as a character, not as SIGINT
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new Error("Cancelled. Nothing was saved."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
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
      remove: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, file] = positionals;

  const version: string = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  if (values.version) return console.log(version), 0;
  if (values.help || !command) return console.log(HELP), command || values.help ? 0 : 1;

  const takesScript = ["check", "snapshot", "render"].includes(command);
  const maxArgs = takesScript || command === "inspect" || command === "key" ? 2 : 1;
  if (command !== "guide" && positionals.length > maxArgs) throw new Error(`Unexpected argument for ${command}: ${positionals[maxArgs]}.`);
  const allowed = command === "render" || command === "snapshot"
    ? ["output", "width", "voice", "speed", "no-captions", "tts-command", ...(command === "snapshot" ? ["sheet", "at", "step"] : ["fps"])]
    : command === "inspect" ? ["output", "at", "motion", "step", "width"] : command === "key" ? ["remove"] : [];
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
      for (const [name, v] of Object.entries(builtInVoices())) console.log(`${name.padEnd(6)}  ${v.language}  ${v.description}`);
      console.log(`\nThese run on this machine. The model has ${SPEAKERS.length} speakers and these are names for four of them;\nany other works by its own name, such as zf_001 or zm_100:\n  https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/main/voices`);
      console.log("Default narration uses maple for English and lin for Mandarin.");
      console.log(`\nMiniMax's voices are paid by the character, with your own API key, and are used only when a script\nor --voice names one. minimax: ${minimaxKeyStatus()}.`);
      for (const v of MINIMAX_VOICES) console.log(`${(MINIMAX_PREFIX + v.name).padEnd(6)}  ${v.language}  ${v.description}`);
      console.log(`Any voice id from MiniMax's list, or one you cloned, works after "${MINIMAX_PREFIX}". The model is\n${MINIMAX_MODEL}; add "@speech-2.8-turbo" to a name for the cheaper one.`);
      return 0;
    }

    case "key": {
      if (file !== "minimax") throw new Error(`Usage: drawcast key minimax [--remove]. MiniMax is the only service drawcast keeps a key for.`);
      if (values.remove) {
        console.log(`Removed the saved MiniMax key from ${await removeMinimaxKey()}.`);
        if (process.env.MINIMAX_API_KEY?.trim()) console.log("MINIMAX_API_KEY is still set in this environment, and is used while it is.");
        return 0;
      }
      const key = await readSecret("MiniMax API key (it is not shown): ", signal);
      if (!key) throw new Error("No key was given, so nothing was saved.");
      if (/\s/.test(key)) throw new Error("That has spaces in it, so it is not one API key. Nothing was saved.");
      const saved = await saveMinimaxKey(key);
      console.log(`Saved the MiniMax key ending ${key.slice(-4)} to ${saved}.`);
      console.log(`A script with "voice": "${MINIMAX_PREFIX}<voice id>" uses it from now on, in any program that runs drawcast.`);
      if (process.env.MINIMAX_API_KEY?.trim()) console.log("MINIMAX_API_KEY is set in this environment, and is used instead while it is.");
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
      console.log(`minimax       ${minimaxKeyStatus()} (needed for MiniMax's paid voices)`);
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
      const started = performance.now();
      const { duration, speechMs, encodingMs } = await renderVideo(loaded, {
        output,
        width,
        fps: number(values.fps, "fps") ?? 30,
        ...speech,
        log,
      });
      const wall = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
      const totalMs = performance.now() - started;
      log(`Phase wall times (may overlap): speech preparation and synthesis ${wall(speechMs)}, video encoding and MP4 muxing ${wall(encodingMs)}`);
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
