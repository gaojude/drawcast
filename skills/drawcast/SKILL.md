---
name: drawcast
description: Make a narrated whiteboard video (MP4) in which an Excalidraw diagram is drawn step by step while a voice explains it, in English or Chinese. Use when asked for an explainer video, an animated diagram, a narrated walkthrough of an architecture, algorithm or process, or a video version of an Excalidraw sketch.
---

# drawcast

drawcast renders a JSON script (narration plus timed Excalidraw drawing actions) into an MP4 with a
locally synthesized voice. You write the script; the `drawcast` command checks and renders it.

## Running the command

It needs Node.js 20 or newer. Before anything else, make sure the command is the latest release:

- Run `drawcast --version` and `npm view drawcast version`.
- If `drawcast` is not on the PATH, use `npx -y drawcast@latest` in place of `drawcast` everywhere
  below. That always fetches the latest release.
- If the installed version is older than the one npm reports, run `npm install -g drawcast@latest`
  and tell the user it was updated. If that fails (for example, no permission), use
  `npx -y drawcast@latest` for this video instead.
- If `npm view` fails (no network), carry on with whatever is installed.

The first render downloads a speech model (about 365 MB), which can take a few minutes.

## Steps

1. Run `drawcast guide` and read all of it. It is the reference for the script format, and it is the
   version that matches the installed command. Do not write a script from memory.
2. Decide what the video should show before writing JSON: what goes on the canvas, in what order, and
   what is said as each part appears. Aim for one idea per step.
3. Write the script to `<name>.drawcast.json`.
4. Run `drawcast check <file>` and fix every error and warning it reports.
5. Run `drawcast snapshot <file>` and look at the PNG it writes. Fix anything that overlaps, is cut
   off, or is hard to read, then check again. Use `--step <n>` to see the canvas partway through.
6. Run `drawcast render <file>`. It prints the path of the MP4. Give that path to the user.

## Notes

- Formulas are supported: a `math` element typesets LaTeX, and Greek letters and maths symbols can be
  typed straight into text and labels. The guide has the details; narration says a formula in words.
- The first frame of the video is a cover for thumbnails: the canvas as step 1 ends. If another step
  makes a better picture of the video, set `"cover"` to its number.
- `drawcast voices` lists the voices. Leave `voice` unset unless the user asks for one: by default the
  narration goes to Microsoft's online voice for its language, and to the built-in voice if `edge-tts`
  or a connection is missing. If the user wants nothing sent online, set a built-in voice (`lin`,
  `chen`, `maple`, `sol`).
- Rendering takes roughly as long as the video is. Speech is cached, so rendering again after changing
  only the drawing is faster.
- If a command fails, read its message: it says what is missing. `drawcast setup` downloads everything
  rendering needs and reports what it found.
