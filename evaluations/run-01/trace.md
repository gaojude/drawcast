# Author run 1 · Wave interference

**Prompt.** “Make a short narrated video for a music student showing two sound waves in phase, slipping out of phase, and cancelling. Let me see how the same peaks add and opposite peaks cancel.”

A fresh author agent started at `48814b6` using only the repository skill and the built CLI. The named local CLI stood in for the published package. Its output directory was under `dist/author1`. The model and browser were already installed, and the speech cache had none of these 14 sentences. The agent chose the default resolution, fps and voice.

## Timed tool trace

[Tool inputs and timestamped results](tools.jsonl) include the script-generation call. Long text outputs are excerpted, and image payloads are represented by media type.

Task start **03:50:40.153 UTC**, completion **03:53:44.406 UTC** on 2026-11-27. Total **184.253 s**, including inspection and the final report. Times below are from the agent's tool-call events. The operation column abbreviates input paths and the script-writing call. It covers every author tool invocation.

| Seconds from start | Operation | Result |
| ---: | --- | --- |
| 7.14 | Read `skills/drawcast/SKILL.md` | Directed to latest guide |
| 10.80 | `guide` | Complete 6,125-token reference (o200k_base, body only) |
| 15.95 | `--version` | Matched the CLI that had just printed the guide |
| 61.44 | Generate and write `waves.drawcast.json` | 4 steps, 35 plot definitions, 76 actions |
| 64.71 | `check waves.drawcast.json` | No problems |
| 69.66 | `snapshot waves.drawcast.json --sheet` | No problems, 4 tiles |
| 76.42 | Open contact sheet | End states and caption clearance looked right |
| 82.97 | `render waves.drawcast.json` | 12.444 s by process stopwatch, 1,193 frames, 39.77 s of video |
| 107.09 | Locate ffmpeg and ffprobe on PATH | Neither found |
| 116.89 | Search dependency tree for ffmpeg | Found bundled executable |
| 124.30 | Collect completed render process output | Online voice unavailable, Maple spoke all 14 sentences |
| 145.62 | Decode MP4 at one frame per two seconds into a contact sheet | H.264 1920×1080 at 30 fps and AAC 48 kHz |
| 152.47 | Inspect decoded frames | Neighbouring curves briefly appear together during transitions |
| 163.44 | Count actions and plot definitions in delivered JSON | 16 phase changes needed 32 extra plot definitions and 48 actions |

## Findings

The baseline script is preserved in [sample.drawcast.json](sample.drawcast.json). Fading between sampled curves produced double strokes. A plot parameter can drive the wave and its sum continuously on a fixed scale. The trace also shows two redundant calls. The guide requested a version check of the same executable, and the separate layout check duplicated the validation done by the required snapshot.

The new quick start is 692 tokens, with detailed topics available individually. Compare the original transitions with the live parameter in [the narrated walkthrough](walkthrough.mp4). The sample's 12.444 s includes cold sentence synthesis and voice fallback. Use paired warm renders for renderer comparisons.

## Renderer timing

The player previously serialized the entire scene at each frame to decide whether to repaint. The new comparison reuses identical timeline elements and compares content when an element object changes. Both versions still encode every frame.

On Windows, the same sample was rendered in separate baseline and candidate builds with the model installed, 14 cached Maple sentences, the default browser encoder, 1920×1080 and 30 fps. The process wall times below include startup and muxing. Order was alternated in pairs.

| Experiment | Baseline times (s) | Candidate times (s) | Median before / after (s) |
| --- | --- | --- | --- |
| Reuse the encoder's last VideoFrame | 3.929, 3.742, 3.775 | 3.842, 3.867, 3.922 | 3.775 / 3.867. Discarded. |
| Reuse unchanged element comparisons | 3.950, 3.896, 3.736 | 3.562, 3.727, 3.936 | 3.896 / 3.727 |
| Same comparison, fixed sketch seeds in both test builds | 5.484, 3.846, 4.235, 4.452, 3.840 | 7.568, 3.905, 4.022, 3.890, 3.815 | 4.235 / 3.905 |

The fixed-seed medians differ by 0.330 s (7.8%). Individual times varied and the candidate was slower in two of the five pairs. This is a clip-specific measurement. To time it locally, render `sample.drawcast.json` once to warm the speech cache, then time repeated `node dist/cli.js render evaluations/run-01/sample.drawcast.json` processes per build.

For the fidelity check only, the two benchmark builds seeded Excalidraw's sketch generator at 123456 and used the same deterministic `Math.random` stream. The final MP4 container hashes differ. Their FFmpeg `-map 0:v:0 -map 0:a:0 -f framemd5` manifests match across all 1,193 decoded video frames and 1,863 audio blocks (manifest SHA-256 `57fde5b231fae05203742abca866e304a456b178ace58334c3d326b35b2ad17d`). The contact sheets also match.
