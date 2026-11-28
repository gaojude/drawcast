# Working on drawcast

## Build and test

Use Node.js 22.18 or newer to run the TypeScript source tests.

```sh
npm install
npm run build        # dist/cli.js and the player page in dist/player
npm test
node dist/cli.js snapshot examples/dns.drawcast.json --sheet
```

`src/player` runs in the browser and turns a script into frames. `src/narration` exports text and imports recording timings,
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
2. **Record.** Export the sentence request. The agent generates the WAVs with the user's TTS tool and writes a result manifest.
3. **Schedule.** Import the recordings and resolve phrase cues against token timestamps or estimates within each measured sentence. The browser computes the full timeline once. The renderer places each clip at its step's start in a temporary PCM track.
4. **Draw and encode.** The browser renders the Excalidraw canvas, captions and pointer for each frame. Where available, WebCodecs encodes H.264 segments in parallel. Otherwise ffmpeg encodes frames from the browser. Both paths mux the same audio as AAC and embed the step index in the MP4.
