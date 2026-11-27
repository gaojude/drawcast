# Run 16 · From bin to shelf

A fresh author started at `8bcccdf` from [PR #26](https://github.com/gaojude/drawcast/pull/26). The prompt requested a single returned library book traveling from its bin to the sorting cart and finally to the shelf. The three stations and the route had to remain clear with the sound off. The supplied inputs were the shipped skill and CLI, local English Maple and a 1280-pixel, 30 fps target.

**146.951 s author wall time** from 18:08:01.160 to 18:10:28.111 UTC on November 27, 2026. The first render took **6.945 s** with four new sentences, including 4.341 s speech and 1.280 s encoding. The revised render took **2.811 s** with four cached sentences, including 0.039 s speech and 1.100 s encoding. The MP4 has 492 frames over 16.4 s with AAC audio.

| Trace calls | Observed work |
| --- | --- |
| 1–4 | Read the skill and CLI, then authored the three stations, the movement paths and a separate SVG for the illustrated book. |
| 5–7 | Rendered and used the recommended motion sheet. It showed the two flights and the final shelf, but missed the stationary book on the cart. |
| 8–10 | Narrowed the shelf plank to resolve a warning where it intentionally overlapped the shelf back, then rendered again. The guide now explains how to judge deliberate layers visually. |
| 11–12 | Chose a timestamp on the cart and several other frames to confirm the complete route. |

## Improvement

An image can hold its own validated SVG in the script. The walkthrough embeds the author's cover, spine and bookmark in a single moving image and needs no separate book asset. File-backed images remain available. The [implementation trace](implementation-tools.jsonl) covers 223.957 s of engineering work outside the author clock.

The motion sheet now adds the indexed step ending after each sampled movement. On the original film one command captures the first transfer, the book on the cart at 7.567 s, the second transfer and the book on the shelf at 11.433 s. Movies without a usable index retain their existing motion inspection.

[Author tool trace](tools.jsonl) · [Author script](sample.drawcast.json) · [Original book asset](book.svg) · [Author film](sample.mp4) · [New encoded motion sheet](arrivals.png) · [Narrated walkthrough](walkthrough.mp4) · [Walkthrough script](walkthrough.drawcast.json)
