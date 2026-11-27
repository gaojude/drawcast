# Author run 8 · Energy on a curved track

**Prompt.** Teach a first-year student why a bead on a smooth U-shaped track moves fastest at the bottom and reaches the same height on the other side with negligible friction. Show the motion and the two equal heights.

A fresh author used the skill and CLI from PR #18 at `9da41e9`. The trial took **168.615 s**, from 05:34:04.811 to 05:36:53.426 UTC on 2026-11-27. Rendering took **7.757 s** for 30.3 s, 911 frames and eight uncached Maple sentences.

| Elapsed | Author action |
| ---: | --- |
| 5–15 s | Opened the skill and CLI guide and requested topics including plots and actions. |
| 64–81 s | Wrote and previewed the lesson. A manually calculated midpoint kept the level line straight between the two plot points. Layout passed. |
| 88 s | Started the only render. The orange bead made one continuous traverse. |
| 111–116 s | Inspected a motion sheet. Its single mid-traverse frame showed motion but could not establish the change in speed. |
| 128 s | Started ten individual decodes at half-second intervals from 14.5 through 19 s. |
| 147 s | Measured the bead's displacement in the sampled images. At a common 384-pixel width, it moved approximately 12, 63 and 8 pixels over half-second intervals near the start, bottom and end. |

## Result

An author can now pass up to twelve exact times to `inspect --at` to compare successive positions. The output is one chronological sheet, with repeated requests for the same frame coalesced. A single timestamp still returns a full-resolution frame. The plots guide also demonstrates a headless arrow connecting two plot coordinates directly to draw a straight chord.

One same-file replay of the ten single-frame CLI commands took **5.344 s**. The new sheet took **0.567 s** and showed all ten instants. The individual commands wrote ten full-size PNGs and the batch wrote one tiled PNG. This measures the two review workflows. The build, typecheck and all 133 tests passed, including timestamp selection, duplicate frames, ordering, argument validation and output dimensions.

The workspace retains the command-level trace in `tools.local.jsonl`.

[Original lesson](sample.mp4) · [Ten decoded instants](bead-times.png) · [Narrated walkthrough](walkthrough.mp4)
