# Run 17 · The missing cart

A fresh author repeated the returned-book prompt on `cc25d3e` from [PR #27](https://github.com/gaojude/drawcast/pull/27). The author used the shipped skill and CLI, kept the three stations visible and placed all five illustrations directly in the script.

**120.089 s author wall time** from 18:17:17.596 to 18:19:17.685 UTC on November 27, 2026. The first render took **6.162 s** with four uncached Maple sentences. The corrected render took **2.604 s** with cached narration. The delivered film is 14.233 s, 427 frames at 1280 × 720 and 30 fps with AAC audio.

| Trace calls | Observed work |
| --- | --- |
| 1–4 | Read the skill and guides and authored five inline SVGs with a viewBox and an explicit on-canvas size. |
| 5–7 | Rendered once. The encoded motion sheet showed a cropped book and bookshelf and a missing sorting cart. |
| 8–11 | Added explicit width and height attributes to the SVG roots, then rendered and reviewed the corrected film. The cover, two transfers and shelf landing became readable. |

## Improvement

The renderer now handles the viewBox-only markup used in the guide. The comparison images below show the same composition without explicit root sizes on both sides. The left is the first encoded frame from the author's failed draft. The right is the corresponding frame rendered by the updated CLI.

Across three 1280 × 720 decoded snapshots, the regions covering the five inline illustrations had zero differing RGB pixels compared with the author's explicitly sized version. The remaining 512 whole-frame differences fell within two separately generated rough arrows. A regression samples both extreme corners of a shifted viewBox, including a stretched display rectangle and roots with just one dimension. The old build lost the far blue corner.

The [implementation and verification trace](implementation-tools.jsonl) covers 493.106 s of engineering work outside the author clock. The maintainer requested that the series end with this fix.

[Before](before.png) · [After](after.png) · [Original motion review](motion.png) · [Author's corrected motion review](sample.inspect.png) · [Author tool trace](tools.jsonl) · [Author script](sample.drawcast.json) · [Author film](sample.mp4) · [Narrated walkthrough](walkthrough.mp4)
