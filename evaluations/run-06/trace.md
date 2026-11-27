# Author run 6 · Insertion sort

**Prompt.** Make a short narrated video for a beginner explaining a single insertion-sort step. Start with the sorted prefix 2, 5, 8 and the key 4. Lift the key out, shift the two larger values one slot right, and put the same key in the hole. Show which values keep their identity throughout.

A fresh subagent received the packaged skill and the local CLI built from main at `ff15584`. The author took **209.672 s**, from 05:10:33.445 to 05:14:03.117 UTC on 2026-11-27. The supplied Windows host had Chrome, FFmpeg and the Maple speech model installed. The original six-step script and final encoded lesson are committed alongside the walkthrough.

| Elapsed | What the tool trace shows |
| ---: | --- |
| 4.558–13.836 s | Read the skill, help, quick start, and four guide topics. |
| 45.552 s | Looked up available voices and chose Maple. |
| 73.825 s | Wrote four dashed slots and four differently colored tiles, calculating both sets of positions. |
| 80–92 s | Previewed the sheet. All six states looked correct. |
| 97–136 s | Rendered and inspected 953 frames. The first frame showed 2, 4, 5, 8 because the author had chosen the finished row for the cover. |
| 159–184 s | Changed only the cover from step 6 to step 1, rendered again, and checked the encoded frames. |
| 195–201 s | Decoded the frame at 24 s and confirmed the orange key was above the empty slot. |

The 31.8 s lesson took **12.55 s** to render with 12 uncached sentences. Correcting the cover took another **4.64 s** with cached speech. These are full process times. The initial sheet displayed each step in sequence, with no indication that the last tile would open the MP4. The quick start encouraged choosing the step that best showed the whole idea.

## Changes and verification

- The preview sheet marks the selected cover as **first frame**. The guide explains the default, an explicit cover and `false`. The shipped skill sends a supplied CLI directly to its quick start.
- A point written as `["slot"]` refers to the center of an existing rectangle, ellipse or diamond. Tiles can share their slot's position with `on`, and routes can refer to centers after a move or resize. The author can lay out each slot once.
- Substituting four slot references for the eight original tile coordinates produced identical expanded scripts. The walkthrough uses the new syntax for placement and animated travel. Regression coverage exercises moved, resized, removed and missing targets.
- Build and typecheck passed. All 132 tests passed with the browser and encoder enabled. The rendered walkthrough was decoded and visually inspected.

The command-level session trace is retained in the trial workspace as `tools.local.jsonl`. The table above summarizes the actions relevant to the result.

[Sample lesson](sample.mp4) · [Author's script](sample.drawcast.json) · [Narrated walkthrough](walkthrough.mp4)
