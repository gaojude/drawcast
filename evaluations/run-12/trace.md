# Run 12 · Budget replay

A fresh author repeated the run 11 household budget prompt on [PR #22](https://github.com/gaojude/drawcast/pull/22) at `47dbe1a`. The author saw the shipped skill and built CLI and had no prior author's script or report.

**103.854 s author wall time** from 17:30:55.046 to 17:32:38.900 UTC on November 27, 2026. One render took **8.959 s** for 958 frames, 31.933 s of 1280 × 720 video at 30 fps and AAC narration. Nine of ten Maple sentences required synthesis.

| Trace calls | What happened |
| --- | --- |
| 1–3 | Read the skill and help, then the quick start. One combined lookup requested six topics, totaling 2,281 words. The author reported the pie topic alone was sufficient. |
| 4 | Wrote three native slices and their narration directly in JSON. All three specified the same center and radius. The starting percentages were 50, 0 and 30. |
| 5–6 | Rendered and reviewed a step sheet. The five layouts passed on the first draft. |
| 7–9 | Rendered once, decoded a motion sheet, and checked all three wedge reveals and the silent final comparison. The inspection command also verified the file's media details. |

## Improvement

Set the first slice's geometry once. A following slice with `"after":"housing","share":30` inherits the circle and starts at housing's clockwise end. The next slice can follow food using the same syntax. The trial's housing slice starts at 50% and ends at the top, which exercises wrapping through 100% to 0%.

The quick start now points directly to a complete narrated example in `guide pie`. The author's 2,281-word combined request and 98-word pie topic were measured on the tested parent commit.

The earlier author spent 154.900 s on the same prompt and generated 126 coordinate pairs. These are two different authors, scripts and speech-cache states. The observed timings describe the individual runs.

The [implementation subagent](implementation-tools.jsonl) took 185.902 s, measured separately. Replacing the repeated geometry in a copy of the author's script with two continuations produced the same three expanded slices, including the wrapped start. Browser tests also covered a predecessor that moved and rotated.

[Author tool trace](tools.jsonl) · [Author script](sample.drawcast.json) · [Author film](sample.mp4) · [Encoded author frames](motion.png) · [Narrated walkthrough](walkthrough.mp4) · [Walkthrough script](walkthrough.drawcast.json)
