# Author run 10 · Undo and Redo replay

A fresh author received the same sample prompt as run 9. It asked for a plain text editor starting with CAT, appending S, undoing S, and then typing a different letter. Both the document and the available history had to stay visible. The author used only the shipped skill and the CLI built from PR #20 at `25a81e2`.

**Author wall time was 143.499 s**, from 05:56:48.652 to 05:59:12.151 UTC on 2026-11-27. The only render took **7.27 s** for 23.0 s of video, 692 frames, and seven uncached local Maple sentences.

| Elapsed | Action and result |
| ---: | --- |
| 5–15 s | Read the skill, quick start and a combined set of guide topics. |
| 30–68 s | Checked the destination and wrote four steps. Three grouped updates tied the document and history to the same narration cues with zero duration. |
| 75–85 s | Generated one validating snapshot sheet and inspected the four layouts. |
| 96 s | Started the only render. |
| 113–119 s | Extracted five exact instants in one inspection call. The encoded document, Undo target and Redo target matched at each state. |
| 135–143 s | Collected the timing and delivered the first draft. |

## Stopping decision

**Zero actionable findings for this prompt.** The original CAT is visible first. Adding S makes CAT undoable. Undo restores CAT and leaves CATS redoable. Typing E produces CATE, clears Redo and keeps CAT available through Undo. Both the document and its history change together. The author used one topic lookup, one layout sheet, one render and one encoded sheet, with no script revisions.

The preceding author took 195.182 s and rendered twice. The two authors wrote different scripts and narration lengths, so the two wall times describe these trials. The command-level trace for each remains in its trial workspace as `tools.local.jsonl`.

[First-draft sample](sample.mp4) · [Encoded states](encoded-states.png) · [Narrated walkthrough](walkthrough.mp4)
