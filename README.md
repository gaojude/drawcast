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

Node.js 20 or newer.

```sh
npm install -g drawcast
drawcast setup        # optional: download the speech model now instead of on the first render
```

Rendering uses three things, and `drawcast setup` reports on each:

- **A speech model**, about 180 MB, downloaded on first use to a cache folder.
- **A Chromium-family browser** to draw the frames. An installed Chrome, Chromium or Edge is used;
  if there is none, a headless Chrome is downloaded.
- **ffmpeg**, which comes with the `ffmpeg-static` dependency. If your npm is set to skip install
  scripts, install ffmpeg yourself or point `DRAWCAST_FFMPEG` at one.

Nothing is sent anywhere: speech, drawing and encoding all happen locally. The one exception is
opt-in: an [online voice](#online-voices), if a script asks for one.

## Use

```
drawcast guide                 the script format, with examples
drawcast check <script>        errors and layout warnings, without rendering
drawcast snapshot <script>     one moment of the canvas as a PNG (--step 2, --at 12.5)
drawcast render <script>       the MP4 (-o out.mp4, --voice chen, --speed 1.1, --no-captions)
drawcast voices                the voices
```

`drawcast guide` prints the full reference, which is also in [`docs/format.md`](docs/format.md). In
short: a script is a list of steps, each with narration (`say`) and actions (`do`). An action adds,
updates or removes an Excalidraw element, moves the camera, or points at something, and its `at` names
the phrase of the narration it starts on. The renderer finds when the voice reaches that phrase: the
start of a sentence exactly, a word inside a sentence to within about a quarter of a second.

`check` exists because whoever writes a script usually cannot see it. It catches references to
elements that are not there, phrases the narration never says, shapes that half overlap, labels that
will not fit and drawings hidden under the captions. `snapshot` renders a still in a second or two, with
no speech, to look at the layout before spending a minute on the video.

## With an agent

drawcast is a command-line program, and its skill is one Markdown file of instructions:
[`skills/drawcast/SKILL.md`](skills/drawcast/SKILL.md). Nothing in either is specific to one agent.
Any agent that can run a shell command can make a video:

- **Claude Code:** `drawcast skill --install` copies the skill to `~/.claude/skills/drawcast`. This
  repository is also a plugin, so its `skills` folder is picked up when the repository is installed
  as one.
- **An agent that reads skills from another folder:** `drawcast skill` prints where the skill is;
  copy that folder to where your agent looks.
- **Any other agent:** tell it to run `drawcast guide` and make a video of what you want explained.

The skill only says what to run: read `drawcast guide`, write a script, `check`, `snapshot`,
`render`. The format reference lives in the command, so the skill does not go out of date with it.

## What it costs in tokens

A script says what to draw and leaves how to the renderer, so there is little of it to write.

| Script | Video | The script | Its finished canvas as an Excalidraw scene |
| --- | --- | --- | --- |
| [`examples/cache.drawcast.json`](examples/cache.drawcast.json) | 18 s | 549 tokens | about 2,000 |
| [`examples/dns.drawcast.json`](examples/dns.drawcast.json) | 27 s | 716 tokens | about 2,550 |
| [`examples/binary-search.drawcast.json`](examples/binary-search.drawcast.json) | 27 s | 685 tokens | about 1,260 |
| [`promo/promo.en.drawcast.json`](promo/promo.en.drawcast.json) | 68 s | 5,995 tokens | about 16,800 |

The last column is the canvas as it stands when the video ends, saved the way Excalidraw saves a
scene and minified. It has no narration and no timing in it, and it is still two to four times the
size of the script that draws it, narrates it and times it.

What an agent reads first does not grow with the video: the skill is about 500 tokens and
`drawcast guide` about 3,400. Layout problems come back from `check` as text, so finding them costs
no screenshots, and one `snapshot` is usually enough to look at before rendering.

These are counts from `o200k_base`, a tokenizer from OpenAI that runs offline; another model's
tokenizer will give somewhat different numbers. The scene sizes move by a fraction of a percent
between runs, because Excalidraw's element ids are random. To measure a script of your own, clone
the repository and run `npm install && npm run build && node scripts/measure-tokens.mjs <script>`.

## Voices

The built-in voice is [ZipVoice](https://github.com/k2-fsa/ZipVoice), run on the CPU by
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). It speaks Mandarin, English, and sentences that
mix the two, at about real-time speed on a laptop CPU. It imitates a short reference clip, and that is
all a drawcast voice is:

- The four built-in voices are synthetic clips, generated with Kokoro. No real person's voice is
  included.
- A script can narrate in any voice from a 3 to 10 second recording of it:
  `"voice": { "clip": "me.wav", "transcript": "exactly what the clip says" }`. A lively clip gives
  lively narration; the model follows the clip's pace and intonation. Only use voices you have the
  right to use.

### Online voices

The built-in voice is good and not great. For narration that sounds closer to a person, a script can
name one of Microsoft's online neural voices, the ones behind Read Aloud in Edge:

```json
{ "drawcast": 1, "voice": "edge:en-US-EmmaMultilingualNeural", "steps": [] }
```

or `drawcast render talk.drawcast.json --voice edge:zh-CN-XiaoxiaoNeural`. `drawcast voices` lists a
few, and `edge-tts --list-voices` has them all. This is optional and works differently from the rest:

- It needs the [`edge-tts`](https://github.com/rany2/edge-tts) program (`pipx install edge-tts` or
  `uv tool install edge-tts`) and a connection. The speech model is not downloaded for it.
- The narration is sent to Microsoft. The built-in voice sends nothing anywhere.
- Microsoft runs this service for its browser and does not offer it as an API, so it can change or
  stop without notice, and it comes with no licence to use the voices elsewhere. For something you
  depend on, use the built-in voice or `--tts-command` with a service you have an agreement with.

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
- With the built-in voice, English words inside a Chinese sentence are less reliable than either
  language alone. In our tests a speech recogniser made out about two in three of them; the rest were
  slurred or dropped. The online voices do not have this problem.
- A word's time inside its sentence is an estimate, good to about a quarter of a second. Sentence
  starts are exact.
- There is no audio besides the narration.

## Credits and licenses

drawcast is MIT licensed. How it works inside, and how to build and test it, is in
[CONTRIBUTING.md](CONTRIBUTING.md). It builds on:

- [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT), bundled into the player with its fonts.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0) and the ZipVoice model its authors
  publish, downloaded at run time. Check the model's own terms before commercial use.
- `assets/lexicon-en.txt.gz`, derived from the English dictionary of
  [misaki](https://github.com/hexgrad/misaki) (Apache-2.0) as shipped with sherpa-onnx's Kokoro model.
- `assets/voices`, spoken by [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) (Apache-2.0).
- ffmpeg, through [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static), which downloads a
  GPL build and runs it as a separate program.

The timeline and drawing approach began in Boardcast, an app for trading whiteboard explanations with
an AI.
