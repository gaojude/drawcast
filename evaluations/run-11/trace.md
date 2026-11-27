# Run 11 · Reading a household budget

A fresh author started from `ccd6625` on main with only the shipped skill and built CLI as product references. The prompt asked for a short English video about a household budget with housing at 50%, food at 30% and savings at 20%. The three shares had to appear as named and remain visible. The final comparison had to work with the sound off. Output settings were local Maple narration, 1280 pixels wide and 30 fps.

**154.900 s author wall time** from 17:21:03.845 to 17:23:38.745 UTC on November 27, 2026, measured from task start to delivery. One render took **10.247 s** with 11 uncached sentences. The MP4 contains 880 frames over 29.333 s, with AAC audio. Eight decoded frames show the three reveals and the equal final bars.

| Trace calls | Observed work | Change in this PR |
| --- | --- | --- |
| 1–4 | Read the skill, help and guides. Searched `guide full` for top-level settings. | The quick start points to `guide script` and the short `guide pie` example. Both can be requested together. |
| 5–9 | Generated three closed lines with 62, 38 and 26 coordinate pairs. Placed labels separately and revised the preview. | A slice takes a center, radius, starting percentage and share. Its filled sector sweeps on cue. The optional label follows the slice. |
| 10–14 | Rendered once. Encoded inspection rejected `--width 512`. Repeated it without the flag. | Inspection accepts a tile width. A single requested frame can also be resized. |
| 15–16 | Looked for ffprobe, then parsed MP4 boxes to check dimensions, timing and audio. | Inspection reports encoded dimensions, duration, video frame count, average fps and the first audio codec. |

## Encoder experiment

An engineering subagent rendered the exact author script with all speech cached. Two builds used the same dependencies, settings and host. The candidate reused the previous WebCodecs frame as the source for unchanged pictures. Each invocation launched a fresh CLI process.

| Order | Build | Process time |
| ---: | --- | ---: |
| 1 | Main | 2.899 s |
| 2 | Reuse frame | 3.005 s |
| 3 | Main | 2.778 s |

All 1,374 decoded audio blocks matched the author's MP4. Video checksums differed even between the two unchanged controls on 869 of 880 frames, so the trial could not establish pixel parity for the candidate. The results favored the existing encoder, which this PR retains.

The [author tool trace](tools.jsonl) records all 16 calls with UTC start and return timestamps. Long outputs are excerpted, image payloads are identified by type, and local paths are shortened. Engineering support took 124.75 s for the [encoder experiment](encoder-tools.jsonl) and 263.06 s for [slice implementation and tests](implementation-tools.jsonl). These are separate from author time.

[Author script](sample.drawcast.json) · [Author film](sample.mp4) · [Encoded author frames](inspection.png) · [Narrated walkthrough](walkthrough.mp4) · [Walkthrough script](walkthrough.drawcast.json)
