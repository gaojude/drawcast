# drawcast

Turn a script into a narrated whiteboard video. You describe what to draw on an
[Excalidraw](https://excalidraw.com) canvas and what to say; drawcast speaks the narration with a
voice that runs on your machine, draws each element as its words are spoken, and writes an MP4.

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

The format is meant to be written by a coding agent as much as by a person, and the repository
includes a skill that teaches an agent to use it. There are more scripts in [`examples`](examples).

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

Nothing is sent anywhere: speech, drawing and encoding all happen locally.

## Use

```
drawcast guide                 the script format, with examples
drawcast check <script>        errors and layout warnings, without rendering
drawcast snapshot <script>     one moment of the canvas as a PNG (--step 2, --at 12.5)
drawcast render <script>       the MP4 (-o out.mp4, --voice chen, --speed 1.1, --no-captions)
drawcast voices                the built-in voices
```

`drawcast guide` prints the full reference, which is also in [`docs/format.md`](docs/format.md). In
short: a script is a list of steps, each with narration (`say`) and actions (`do`). An action adds,
updates or removes an Excalidraw element, moves the camera, or points at something, and its `at` names
the spoken phrase it starts on.

`check` exists because whoever writes a script usually cannot see it. It catches references to
elements that are not there, phrases the narration never says, shapes that half overlap, labels that
will not fit and drawings hidden under the captions. `snapshot` renders a still in a second or two, with
no speech, to look at the layout before spending a minute on the video.

## With a coding agent

The skill in [`skills/drawcast`](skills/drawcast) is a short set of instructions: read
`drawcast guide`, write a script, `check`, `snapshot`, `render`. The format reference lives in the
command, so the skill never goes out of date with it.

```sh
drawcast skill --install      # copies the skill to ~/.claude/skills/drawcast
```

For Claude Code, this repository is also a plugin: its `skills` folder is picked up when the
repository is installed as one. Any other agent can be told to run `drawcast guide` and take it from
there.

## Voices

The voice is [ZipVoice](https://github.com/k2-fsa/ZipVoice), run on the CPU by
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). It speaks Mandarin, English, and sentences that
mix the two, at about real-time speed on a laptop CPU. It imitates a short reference clip, and that is
all a drawcast voice is:

- The four built-in voices are synthetic clips, generated with Kokoro. No real person's voice is
  included.
- A script can narrate in any voice from a 3 to 10 second recording of it:
  `"voice": { "clip": "me.wav", "transcript": "exactly what the clip says" }`. A lively clip gives
  lively narration; the model follows the clip's pace and intonation. Only use voices you have the
  right to use.

To use another speech engine altogether, pass `--tts-command`. The command is run once per sentence,
gets the sentence on stdin, and must write a WAV file to the path in `$DRAWCAST_OUT`:

```sh
drawcast render talk.drawcast.json --tts-command "python my_tts.py"
```

## How it works

1. **Check.** The script is validated, with layout estimated from the element sizes.
2. **Speak.** Narration is split into sentences and each is synthesized and cached. English words are
   turned into phonemes with a pronunciation dictionary and Chinese into pinyin with the tone changes
   of connected speech; numbers and acronyms are written out first. `--speed` changes the tempo of the
   finished audio, not the voice.
3. **Schedule.** Each `at` phrase is located in its sentence. Sentence boundaries are exact; a word's
   position inside its sentence is estimated from syllable counts, which lands within about a quarter
   of a second.
4. **Draw.** A headless browser loads Excalidraw. Every element has a track of animated segments, so
   the canvas at any time is a pure function of that time; each frame is rendered with Excalidraw's
   own export and has the pointer and captions painted on top.
5. **Encode.** Frames and the narration track are piped to ffmpeg: H.264 and AAC, 1920 x 1080 at 30
   frames per second by default.

## Limits

- Chinese means Mandarin. Other languages are not supported by the built-in voice.
- The English dictionary has about 178,000 words. An unknown word is assembled from known ones or read
  by spelling rules, which is sometimes wrong for names. Respell a name the way it sounds if it comes
  out badly.
- English words inside a Chinese sentence are less reliable than either language alone. In our tests
  a speech recogniser made out about two in three of them; the rest were slurred or dropped. The
  model paces a sentence by the language of the voice clip, and the other language gets the wrong
  tempo.
- Word timing inside a sentence is an estimate, as described above.
- There is no audio besides the narration.

## Development

```sh
npm install
npm run build        # dist/cli.js and the player page in dist/player
npm test
node dist/cli.js render examples/dns.drawcast.json
```

`src/player` runs in the browser and turns a script into frames. `src/voice` is the speech pipeline,
`src/format/check.ts` the checker, and `src/render` drives the browser and ffmpeg. The two files in
`assets` are generated by `scripts/make-lexicon.mjs` and `scripts/make-voices.mjs`.

## Credits and licenses

drawcast is MIT licensed. It builds on:

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
