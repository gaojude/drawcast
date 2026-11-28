# Working on drawcast

## Build and test

Use Node.js 22.18 or newer to run the TypeScript source tests.

```sh
npm install
npm run build        # dist/cli.js and the player page in dist/player
npm test
node dist/cli.js render examples/dns.drawcast.json
```

`src/player` runs in the browser and turns a script into frames. `src/voice` is the speech pipeline,
`src/format/check.ts` the checker, `src/math` typesets formulas, and `src/render` drives the browser
and ffmpeg.

`docs/guide.md` is the quick start printed by `drawcast guide`. `docs/format.md` supplies
`guide full` and the named topics. Give each topic a level-two heading and use level-three
headings for its subsections. `drawcast guide plots math` prints those topics in order.
Keep the workflow and reference in the CLI so installed skills can pick up changes.

## Publish to npm

Every PR must add a new changeset. Run `npm run changeset`, select a patch, minor, or
major bump for `drawcast`, and write a release note for users. For work with no release
impact, including docs-only changes, run `npm run changeset -- --empty`. Commit the
generated Markdown file. The **Require changeset** check runs on every pull request.

### Add the npm token to GitHub

1. Sign in to npm with an account that can publish `drawcast`. Open your profile menu,
   choose **Access Tokens**, and generate a **Granular Access Token**.
2. Give the token a name and expiration date. Under **Packages and scopes**, grant
   **Read and write** access to the `drawcast` package. Enable **Bypass two-factor
   authentication (2FA)** so GitHub Actions can publish unattended. Generate and copy the token.
3. In the GitHub repository, open **Settings > Secrets and variables > Actions**.
   Choose **New repository secret**, name it `NPM_TOKEN`, paste the token as the value,
   and select **Add secret**. [Open this repository's Actions secrets](https://github.com/gaojude/drawcast/settings/secrets/actions).
4. Before the token expires, generate a replacement, update the same GitHub secret,
   and revoke the old token in npm.

### Release a stable version

1. On a release branch, run `npm run changeset -- status` to inspect the pending
   bumps, then `npm run changeset -- version` to consume the notes, update
   `package.json`, and generate the changelog. Run `npm install --package-lock-only`
   and set the same version in `.claude-plugin/plugin.json`. Run
   `npm run changeset -- --empty` to record the release PR itself, then commit
   the generated files and deletions and merge the PR into `main`.
2. Merging into `main` publishes the release. Once Linux, macOS, and Windows pass,
   **Publish to npm** in the merge's **Verify** run checks whether the `package.json`
   version is already on npm. If it isn't, the job builds the tarball, publishes it with
   the `latest` dist-tag, and pushes the matching `v` tag. Pushes that don't change the
   version skip publishing. Confirm with `npm view drawcast dist-tags.latest`.

If publishing fails because the token expired, replace the secret and use **Re-run failed jobs**
on the merge's workflow run.

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
   connected speech. The default voice uses this local engine. A
   `minimax:` voice posts the sentence to MiniMax's HTTP API with the user's own key, from
   `MINIMAX_API_KEY` or the file `drawcast key minimax` saves, and gets raw PCM back; it is paid, so
   it never stands in for another voice. `--speed` changes the tempo of the finished audio, not the
   voice; a MiniMax voice is instead asked to speak at that speed, which it paces more naturally, and
   its speech is cached for each speed apart.
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
