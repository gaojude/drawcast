# Run 13 · One hundred library books

A fresh author started at `43d9fe7` on [PR #23](https://github.com/gaojude/drawcast/pull/23). The prompt asked for one pie chart of 100 new library books, with 40 fiction, 35 history and 25 science. Each category had to appear on cue. The ending had to show, with the sound off, that history and science together exceed fiction by 20. The author used the shipped skill and CLI with local Maple narration.

**97.791 s author wall time** from 17:38:00.858 to 17:39:38.649 UTC on November 27, 2026. The only render took **9.146 s** including synthesis of all nine sentences. Output was 26.667 s, 800 frames at 1280 × 720 and 30 fps, with AAC narration.

| Trace calls | Observation |
| --- | --- |
| 1–3 | Read help, the skill, quick start and a combined set of five guide topics. |
| 4 | Authored the three wedges with one explicit center and two continuations. For the empty circle the author converted the center and radius to an ellipse's top-left corner and diameter. |
| 5–6 | A 1.466 s pre-render sheet showed the six layouts. The sheet's estimated ending was 28.9 s. |
| 7–9 | Rendered, then chose eight timestamps to review the encoded lesson. The last image retains all three shares with “35 + 25 = 60 books,” “60 − 40 = 20” and “20 more than fiction.” |

## Improvement

The pie guide now demonstrates a neutral 100% disk. The first colored slice follows that disk and inherits its center and radius. The remaining neutral area stays visible while the budget of 100 books fills in.

The updated CLI can inspect the encoded movie at step numbers using the render's actual schedule. On this film, an 84-byte index identified steps 2, 4 and 6 at 7.267, 12.833 and 24.133 s. The three decoded tiles show fiction, the completed pie and the final comparison. The quick start uses step inspection after rendering. Authors can still choose a layout preview before rendering, timestamps for exact moments or a motion sheet for transitions.

The [implementation and verification trace](implementation-tools.jsonl) covers 543.965 s of engineering work outside the author clock. At 4.75 fps both the native and forced ffmpeg render selected frame 35 for step 2. For each encoder, its step-selected PNG matched its time-selected PNG byte for byte.

The committed author film was made on the parent revision. To reproduce the new inspection on the same script, render a fresh copy with the updated CLI:

```sh
node dist/cli.js render evaluations/run-13/sample.drawcast.json --width 1280 -o library.mp4
node dist/cli.js inspect library.mp4 --step 2,4,6
```

[Author tool trace](tools.jsonl) · [Author script](sample.drawcast.json) · [Author film](sample.mp4) · [Original timestamp review](sample.inspect.png) · [Encoded review by step](encoded-steps.png) · [Narrated walkthrough](walkthrough.mp4) · [Walkthrough script](walkthrough.drawcast.json)
