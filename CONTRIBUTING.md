# Working on drawcast

## Build and test

```sh
npm install
npm run build        # dist/cli.js and the player page in dist/player
npm test
node dist/cli.js render examples/dns.drawcast.json
```

`src/player` runs in the browser and turns a script into frames. `src/voice` is the speech pipeline,
`src/format/check.ts` the checker, and `src/render` drives the browser and ffmpeg.

`docs/format.md` is what `drawcast guide` prints, so a change to the format is a change to that file
too.

## How a script becomes a video

1. **Check.** The script is validated, with layout estimated from the element sizes.
2. **Speak.** Narration is split into sentences and each is synthesized and cached. For the built-in
   voice, numbers and acronyms are written out, then English words are turned into phonemes and
   Chinese into syllables with the model's two pronunciation dictionaries. A word the English one
   lacks is built from words it has or read by spelling rules, and Chinese gets the tone changes of
   connected speech. An `edge:` voice hands the sentence to the `edge-tts` program instead. `--speed`
   changes the tempo of the finished audio, not the voice.
3. **Schedule.** Each `at` phrase is located in its sentence. Sentence boundaries are exact; a word's
   position inside its sentence is estimated from syllable counts, which lands within about a quarter
   of a second.
4. **Draw.** A headless browser loads Excalidraw. Every element has a track of animated segments, so
   the canvas at any time is a pure function of that time; each frame is rendered with Excalidraw's
   own export and has the pointer and captions painted on top.
5. **Encode.** Frames and the narration track are piped to ffmpeg: H.264 and AAC, 1920 x 1080 at 30
   frames per second by default.

## The token figures in the README

```sh
npm run build
node scripts/measure-tokens.mjs examples/dns.drawcast.json promo/promo.en.drawcast.json
```

It counts the script as written, and the canvas at the end of the video as a minified Excalidraw
scene, both with the `o200k_base` tokenizer. Run it again and update the README table when a listed
script changes. The promo video states its own numbers on screen, so a change to
`promo/promo.en.drawcast.json` means measuring it, correcting those numbers, and rendering again.
