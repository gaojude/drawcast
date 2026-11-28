# Drawcast

Ask your coding agent to explain something on a whiteboard. The agent writes a short script and records the narration with your choice of text-to-speech. Drawcast draws the diagram in sync with the recording and exports an MP4.

![A frame from a Drawcast video](promo/cover.en.png)

## Make your first video

Give this prompt to your agent:

> Install the Drawcast skill with `npx -y skills add gaojude/drawcast -g -y`. Make a one-minute video explaining DNS. Help me set up a local Kokoro voice if I don't have TTS configured. Remember the voice settings for future videos, and show me the finished MP4.

Already use another TTS model or service? Name it in your prompt. Your agent handles its setup and can reuse the recordings when you change a drawing.

## How it works

1. The agent writes a script with sentences to narrate and drawing cues tied to phrases. It can preview the layout before recording.
2. Drawcast exports a JSON request. The agent generates the WAVs and writes a result JSON matching each sentence ID to its audio. One WAV per sentence is enough. Longer takes can include timestamps.
3. Drawcast takes the script, result JSON and WAVs, calculates the timeline and writes the video.

```sh
drawcast narration export lesson.drawcast.json -o request.json
# The agent uses your TTS tool to produce result.json and its WAVs.
drawcast render lesson.drawcast.json --narration result.json -o lesson.mp4
```

Requires Node.js 22.12 or newer. The skill uses `npx -y drawcast@latest`. For a global CLI, run `npm install -g drawcast`. Use `drawcast setup` to find a browser and ffmpeg. It downloads headless Chrome when needed. If ffmpeg is missing, install it or set `DRAWCAST_FFMPEG` to its executable.

Read `drawcast guide` for authoring and `drawcast guide narration` for the TTS handoff. [Example scripts](examples) · [Format reference](docs/format.md) · [Contributing](CONTRIBUTING.md)

Drawcast is MIT licensed. The player uses Excalidraw and MathJax. Encoding uses ffmpeg as a separate program through ffmpeg-static. [License](LICENSE)
