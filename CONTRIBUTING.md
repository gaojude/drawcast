# Working on drawcast

## Build and test

```sh
npm install
npm run build        # dist/cli.js and the player page in dist/player
npm test
node dist/cli.js render examples/dns.drawcast.json
```

`src/player` runs in the browser and turns a script into frames. `src/voice` is the speech pipeline,
`src/format/check.ts` the checker, `src/math` typesets formulas, and `src/render` drives the browser
and ffmpeg.

`docs/format.md` is what `drawcast guide` prints, so a change to the format is a change to that file
too.

## How a script becomes a video

1. **Check.** The script is validated, with layout estimated from the element sizes. A `math`
   element is typeset here, by MathJax in Node, into an SVG of glyph outlines: that gives the checker
   its exact size and the LaTeX errors, and the same SVG is later handed to the browser as an image.
   MathJax is bundled into `dist/cli.js` and loaded only for a script that has a formula.
2. **Speak.** Narration is split into sentences and each is synthesized and cached, several at a time
   when the machine has the cores for it. The browser of step 4 starts meanwhile. For the built-in
   voice, numbers and acronyms are written out, then English words are turned into phonemes and
   Chinese into syllables with the model's two pronunciation dictionaries. A word the English one
   lacks is built from words it has or read by spelling rules, and Chinese gets the tone changes of
   connected speech. An `edge:` voice, the default, hands the sentence to the `edge-tts` program
   instead; if that fails and the script named no voice, the whole script is spoken again by the
   built-in voice, and whatever of the video was made to the first voice is made again. `--speed`
   changes the tempo of the finished audio, not the voice.
3. **Schedule.** Each `at` phrase is located in its sentence. Sentence boundaries are exact; a word's
   position inside its sentence is estimated from syllable counts, which lands within about a quarter
   of a second. A step is scheduled as soon as it and the steps before it are spoken: where it falls
   depends on their audio and its own, never on what comes after. So everything up to the start of
   the next step is settled, and steps 4 and 5 work on that much while the rest is still being
   spoken, which is the slowest part of a first render.
4. **Draw.** A headless browser loads Excalidraw. Every element has a track of animated segments, so
   the canvas at any time is a pure function of that time; each frame is rendered with Excalidraw's
   own export and has the pointer and captions painted on top. The first frame is the exception: in
   place of the empty canvas at time zero it shows the cover, the canvas as the script's `cover` step
   ends, with nothing painted on top. No frame is added, so the timing and the sound are unchanged.
5. **Encode.** The browser's own H.264 encoder (WebCodecs) takes each frame straight from the canvas,
   so the pictures never leave the page. The video is cut into segments of a few seconds that each
   start with a key frame, and two encoders share them; a segment is made once all of its frames are
   settled. The cover is a segment of one frame, made when its step has been spoken. ffmpeg copies the finished H.264 into an MP4 beside the narration, which reaches it on a
   second pipe as it settles and is encoded as AAC: 1920 x 1080 at 30 frames per second by default.

   An encoder is tried before it is trusted: it is given a test card, the result is decoded again,
   and the two are compared. Chrome's software encoder stretches a picture from the graphics card by
   two pixels when the width is not a multiple of four, and an encoder may store colours in one range
   and report another; neither says so. One that fails is passed over for the next (software first,
   then whatever the machine has).

   A browser with no encoder that passes (Chromium can be built without H.264) gets the slow way
   instead, as does a render whose quick way fails partway: every frame leaves the page as a PNG and
   ffmpeg encodes them with x264. That takes several times as long, most of it spent making PNGs.
   `DRAWCAST_ENCODER=ffmpeg` forces it, to compare the two or to work around a misbehaving encoder.

## The token figures in the README

```sh
npm run build
node scripts/measure-tokens.mjs examples/dns.drawcast.json promo/promo.en.drawcast.json
```

It counts the script as written, and the canvas at the end of the video as a minified Excalidraw
scene, both with the `o200k_base` tokenizer. Run it again and update the README table when a listed
script changes. The promo video states its own numbers on screen, so a change to
`promo/promo.en.drawcast.json` means measuring it, correcting those numbers, and rendering again.
