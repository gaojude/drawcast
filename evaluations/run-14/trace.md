# Run 14 · Library replay

A fresh author repeated the 100-book library prompt on `cce7d07` from [PR #24](https://github.com/gaojude/drawcast/pull/24). The author started with the shipped skill and supplied CLI.

**122.571 s author wall time** from 17:50:47.021 to 17:52:49.592 UTC on November 27, 2026. One render took **7.414 s** including eight uncached Maple sentences. The film has 765 frames over 25.5 s at 1280 × 720 and 30 fps with AAC narration.

| Trace calls | Evidence and response |
| --- | --- |
| 1–4 | Read the skill and guides, then used a single 100% disk and three chained, labeled wedges. The pie guide supplied the complete construction. |
| 5–8 | Both a standalone check and a snapshot reported the same 16-pixel overlap in the two-color final equation. The author moved the result and checked again. The quick start now says that both render and snapshot include the script check. The text reference demonstrates a right-aligned prefix and a left-aligned result at a shared join. |
| 9 | Clocked the render at 7.414 s. The CLI rounded its own timer to whole seconds. Successful renders now report total wall time to milliseconds plus the overlapping speech and encoding intervals. |
| 10–13 | Reviewed six steps, then chose 25.4 s separately to verify that the comparison stayed readable after captions. Step inspection now uses the final held frame for the last step. |

## Verification

On the author's original MP4, the last step now selects frame 765 at 25.467 s. Its full-size PNG is byte-identical to selecting the same frame by timestamp. The walkthrough uses two independently cued text elements with a ten-unit join and validates without overlap warnings.

For the walkthrough's 1,198 frames, the CLI measured 10.580 s total, 9.375 s for speech and 3.972 s for video encoding and muxing. The timers measure elapsed intervals and include waiting. Their sum exceeds total wall time because speech and encoding run concurrently. The [timing implementation and verification trace](implementation-tools.jsonl) covers 298.837 s of engineering work outside the author clock.

[Author tool trace](tools.jsonl) · [Author script](sample.drawcast.json) · [Author film](sample.mp4) · [Original step review](sample.inspect.png) · [Final author frame](layout.png) · [Narrated walkthrough](walkthrough.mp4) · [Walkthrough script](walkthrough.drawcast.json)
