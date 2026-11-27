# Run 15 · Reviewing the reveals

A fresh author repeated the library acquisitions prompt on `9e7cb93` from [PR #25](https://github.com/gaojude/drawcast/pull/25). The author used the shipped skill and supplied CLI.

**114.216 s author wall time** from 18:01:28.567 to 18:03:22.783 UTC on November 27, 2026. The single render took **6.811 s** by process stopwatch. The CLI measured 6.392 s internally, including 5.426 s of speech preparation and synthesis and 1.711 s of overlapping video encoding and muxing. All seven Maple sentences were uncached. The encoded MP4 is 21.167 s, 635 frames at 1280 × 720 and 30 fps with AAC audio.

| Trace calls | What happened |
| --- | --- |
| 1–3 | Read the skill, quick start and one combined topic lookup. |
| 4–6 | Wrote the script, then previewed the layout. No revisions were needed. |
| 7–9 | Rendered once and inspected the six encoded step endings. The result and all three labels remained legible in the last frame. |
| 10–11 | To check the reveals in progress, the author picked nine timestamps around the reported step boundaries and decoded a second sheet. |

## Improvement

The quick start now names the inspection mode by the question the author needs to answer. For this prompt, one `inspect --motion` call selected 3.867, 6.133 and 8.467 s during the fiction, history and science sweeps, plus the final comparison at 21.133 s. The walkthrough shows the actual encoded step sheet alongside the evidence for this change. Motion selection uses image changes, so specific instants are still available through `--at`.

The author also entered the numerical shares in the two final equations. The input was a fixed 100-book collection, the arithmetic matched the labels on the first draft, and the trace contains no correction or computation workaround. This run supplied evidence for simplifying inspection.

[Author tool trace](tools.jsonl) · [Author film](sample.mp4) · [Author script](sample.drawcast.json) · [Chosen timestamps](sample.inspect.times.png) · [Automatic motion selection](motion-review.png) · [Narrated walkthrough](walkthrough.mp4)
