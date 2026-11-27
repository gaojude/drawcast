# drawcast

Narrated whiteboard videos from a text file. You describe what to draw on an
[Excalidraw](https://excalidraw.com) canvas and what to say; drawcast speaks the narration, draws
each element as its words are spoken, and writes an MP4.

```json
{
  "drawcast": 1,
  "steps": [
    {
      "say": "Take a client and a server. Every page load begins with a request from one to the other.",
      "do": [
        { "at": "client", "add": { "id": "client", "type": "rectangle", "x": 140, "y": 280, "width": 220, "height": 110, "label": "Client" } },
        { "at": "server", "add": { "id": "server", "type": "rectangle", "x": 900, "y": 280, "width": 220, "height": 110, "label": "Server" } },
        { "at": "request", "add": { "id": "request", "type": "arrow", "from": "client", "to": "server", "label": "GET /" } }
      ]
    }
  ]
}
```

```sh
npx drawcast render hello.drawcast.json     # writes hello.mp4
```

The format is meant to be written by a coding agent as much as by a person. The goal is to make an
agent's explanations quicker to take in: a model writes faster than anyone can read, so let it draw
and talk instead.

[![A frame of the drawcast promo video](promo/cover.en.png)](promo/promo.en.drawcast.json)

That frame is from a 68 second video rendered from
[`promo/promo.en.drawcast.json`](promo/promo.en.drawcast.json) with the one command it shows. There
are shorter scripts in [`examples`](examples).

## Install

You do not run drawcast yourself; your coding agent does. So the way to install it is to ask the
agent. Paste this into Claude Code, Codex, Cursor, Gemini CLI or any other agent that can run a shell
command:

```text
Install the drawcast skill with `npx skills add gaojude/drawcast -g -y`, then make me a video explaining how DNS works.
```

After that, just ask for a video. [skills.sh](https://skills.sh) puts the skill where each agent on
your machine looks for skills, and the skill runs the `drawcast` command through `npx`, so there is
nothing else to install. It needs Node.js 22.12 or newer.

To try it once without installing anything:

```text
Run `npx -y drawcast@latest guide`, then make me a video explaining how DNS works.
```

### By hand

The command also works on its own:

```sh
npm install -g drawcast
drawcast setup        # optional: download the speech model now instead of on the first render
```

Rendering uses three things, and `drawcast setup` reports on each:

- **A speech model**, about 365 MB, downloaded on first use to a cache folder.
- **A Chromium-family browser** to draw the frames and encode the video. An installed Chrome,
  Chromium or Edge is used; if there is none, a headless Chrome is downloaded. A browser built
  without an H.264 encoder still works, several times more slowly.
- **ffmpeg**, to put picture and sound in one file. It comes with the `ffmpeg-static` dependency. If
  your npm is set to skip install scripts, install ffmpeg yourself or point `DRAWCAST_FFMPEG` at one.

Drawing and encoding happen locally. Speech does too, except for one thing: when
[`edge-tts`](#online-voices) is installed and a script does not name a voice, the narration goes to
Microsoft's online voice, and a script that names a [MiniMax voice](#minimax-voices) sends it to
MiniMax. Name a built-in voice (`--voice lin`) to keep it all on your machine.

## Use

```
drawcast guide [topic ...]     quick start, selected topics, or the full reference
drawcast check <script>        errors and layout warnings, without rendering
drawcast snapshot <script>     stills as PNG: --sheet (every step on one picture), --step 2,5, --at 12.5
drawcast render <script>       the MP4 (-o out.mp4, --voice lin, --speed 1.1, --no-captions)
drawcast voices                the voices
drawcast key minimax           save the API key for MiniMax's paid voices
```

`drawcast guide` prints a short authoring workflow. Use `guide plots math` for function curves
and LaTeX together, or `guide full` for the [full reference](docs/format.md).
A script is a list of steps, each with narration (`say`) and actions (`do`). An action adds,
updates or removes an Excalidraw element, moves an element along a path, sends a dot along an arrow,
pulses something, moves the camera, or points at something, and its `at` names the phrase of the
narration it starts on. The renderer finds when the voice reaches that phrase: the
start of a sentence exactly, a word inside a sentence to within about a quarter of a second.

The first frame of the video is a cover, the canvas once step 1 is done, so a feed that takes its
thumbnail from that frame does not show an empty canvas. `"cover": 3` in the script picks another
step and `"cover": false` leaves the cover out.

Besides Excalidraw's shapes, text, arrows and images there is a `math` element, which typesets a
formula from LaTeX: `{ "type": "math", "tex": "\\frac{n(n+1)}{2}" }`. It is written out as it
appears, and an update can replace it with the next line of a derivation.
[`examples/pythagoras.drawcast.json`](examples/pythagoras.drawcast.json) uses one. A `line` with `fn`
plots a function, such as `"fn": "x^2 / 4"`, and something can then roll along the curve.

`check` exists because whoever writes a script usually cannot see it. It catches references to
elements that are not there, phrases the narration never says, shapes that half overlap, arrows that cross or run through
something, labels that will not fit and drawings hidden under the captions. `snapshot --sheet` draws
every step, as it ends, on one picture in a second or two, with no speech, so the whole layout is one
look before rendering the video.

## With an agent

drawcast is a command-line program, and its skill is one Markdown file of instructions:
[`skills/drawcast/SKILL.md`](skills/drawcast/SKILL.md). Nothing in either is specific to one agent.
Any agent that can run a shell command can make a video:

- **An agent that reads skills:** `npx skills add gaojude/drawcast` installs the skill for the agents
  it finds, in this project, or for every project with `-g`. `-a <agent>` picks the agents. This is
  the command the prompt under [Install](#install) has the agent run for you.
- **Claude Code, as a plugin:** this repository is also a plugin, so its `skills` folder is picked up
  when the repository is installed as one.
- **Any other agent:** tell it to run `npx -y drawcast@latest guide` and make a video of what you
  want explained.

The skill uses `npx -y drawcast@latest guide` by default. When you supply a particular CLI,
the agent reads its guide and uses the same command throughout.

## What it costs in tokens

A script says what to draw and leaves how to the renderer, so there is little of it to write.

| Script | Video | The script | Its finished canvas as an Excalidraw scene |
| --- | --- | --- | --- |
| [`examples/cache.drawcast.json`](examples/cache.drawcast.json) | 16 s | 549 tokens | about 2,000 |
| [`examples/dns.drawcast.json`](examples/dns.drawcast.json) | 23 s | 716 tokens | about 2,550 |
| [`examples/binary-search.drawcast.json`](examples/binary-search.drawcast.json) | 25 s | 685 tokens | about 1,260 |
| [`promo/promo.en.drawcast.json`](promo/promo.en.drawcast.json) | 68 s | 5,995 tokens | about 16,800 |

The last column is the canvas as it stands when the video ends, saved the way Excalidraw saves a
scene and minified. It has no narration and no timing in it, and it is still two to four times the
size of the script that draws it, narrates it and times it.

The default guide fits in about 700 tokens. Topics are read on demand. A single
`snapshot --sheet` checks the script and draws a contact sheet of the steps.

These are counts from `o200k_base`, a tokenizer from OpenAI that runs offline; another model's
tokenizer will give somewhat different numbers. The scene sizes move by a fraction of a percent
between runs, because Excalidraw's element ids are random. To measure a script of your own, clone
the repository and run `npm install && npm run build && node scripts/measure-tokens.mjs <script>`.

## Voices

Left unset, a script is narrated by an [online voice](#online-voices) for the language of its
narration: `edge:zh-CN-XiaoxiaoNeural` for Chinese and `edge:en-US-EmmaMultilingualNeural` for
English. If that cannot be had (no `edge-tts`, no connection), the built-in voice says the whole
script instead, so one video never has two voices in it. A voice the script or `--voice` names is
used as it is, with no fallback.

The built-in voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh), a small speech
model run on the CPU by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). It speaks Mandarin and
English several times faster than real time on a laptop, and the model is Apache-2.0 licensed.

`drawcast voices` lists four built-in voices: `lin` (female) and `chen` (male) for Chinese, `maple`
and `sol` for English. The fallback is the first one for the language of the narration: `lin` or
`maple`.

The four are made from the model's 103 speakers. `maple` and `sol` are two of them as they are.
`chen` and `lin` are each a Chinese speaker with a third of an English one mixed in, because the
Chinese speakers on their own say English terms poorly. A script can also ask for any speaker by the
model's own name for it, such as `"voice": "zf_001"`.

### Online voices

The built-in voice is good and not great. Microsoft's online neural voices, the ones behind Read
Aloud in Edge, sound closer to a person, so they are the default. A script can also name one:

```json
{ "drawcast": 1, "voice": "edge:en-US-AvaMultilingualNeural", "steps": [] }
```

or `drawcast render talk.drawcast.json --voice edge:zh-CN-YunxiNeural`. `drawcast voices` lists a
few, and `edge-tts --list-voices` has them all. They work differently from the built-in voice:

- They need the [`edge-tts`](https://github.com/rany2/edge-tts) program (`pipx install edge-tts` or
  `uv tool install edge-tts`) and a connection. Without them, a script that names no voice falls back
  to the built-in one.
- The narration is sent to Microsoft. The built-in voice sends nothing anywhere.
- Microsoft runs this service for its browser and does not offer it as an API, so it can change or
  stop without notice, and it comes with no licence to use the voices elsewhere. For something you
  depend on, use the built-in voice or `--tts-command` with a service you have an agreement with.

### MiniMax voices

[MiniMax](https://platform.minimax.io)'s speech models are more expressive still, and they are paid:
each character spoken is billed to your own MiniMax account. A script uses one only when it names one,
and never as a fallback:

```json
{ "drawcast": 1, "voice": "minimax:male-qn-qingse", "steps": [] }
```

Any voice id from MiniMax's list works after `minimax:`, including a voice you cloned there. The
model is `speech-2.8-hd`; `minimax:male-qn-qingse@speech-2.8-turbo` picks the cheaper one. A sentence
spoken once is cached, so rendering again, or after editing one sentence, pays only for what is new.

The API key never goes in a script. Save it once, in your own terminal:

```sh
drawcast key minimax          # paste the key; it is not shown
```

It is saved where drawcast keeps its settings (the command says where), readable only by you,
and every later render uses it, including one an agent runs in a session that was already open.
`MINIMAX_API_KEY`, when set, is used instead, and `drawcast key minimax --remove` deletes the saved
key. So an agent never needs to see the key: when a render reports that none is set, it asks you to
run the command above.

A key belongs to MiniMax's international platform or to its platform for mainland China. drawcast
tries `api.minimax.io` and then `api.minimaxi.com`; set `MINIMAX_API_HOST` to go straight to one.

### Another engine

To use another speech engine altogether, pass `--tts-command`. The command is run once per sentence,
gets the sentence on stdin, and must write a WAV file to the path in `$DRAWCAST_OUT`:

```sh
drawcast render talk.drawcast.json --tts-command "python my_tts.py"
```

## Limits

- Chinese means Mandarin. Other languages are not supported by the built-in voice.
- The built-in voice's English dictionary has about 178,000 words. An unknown word is assembled from
  known ones or read by spelling rules, which is sometimes wrong for names. Respell a name the way it
  sounds if it comes out badly.
- English words inside a Chinese sentence are less reliable than either language alone. In our tests
  a speech recogniser made out about four in five of them with `chen` and two in three with `lin`. It
  made out seven in ten with an online voice, and half with the model's Chinese speakers as they are.
- A word's time inside its sentence is an estimate, good to about a quarter of a second. Sentence
  starts are exact.
- There is no audio besides the narration.

## Credits and licenses

drawcast is MIT licensed. How it works inside, and how to build and test it, is in
[CONTRIBUTING.md](CONTRIBUTING.md). It builds on:

- [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT), bundled into the player with its fonts.
- [MathJax](https://github.com/mathjax/MathJax-src) (Apache-2.0), bundled into the command with its
  TeX font, which typesets the formulas.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0), which runs the speech model.
- [Kokoro v1.1](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) (Apache-2.0), the speech model,
  downloaded at run time in sherpa-onnx's packaging of it. The pronunciation dictionaries that come
  with it are from [misaki](https://github.com/hexgrad/misaki) (Apache-2.0).
- ffmpeg, through [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static), which downloads a
  GPL build and runs it as a separate program.

The timeline and drawing approach began in Boardcast, an app for trading whiteboard explanations with
an AI.
