# Author run 2 · Sigmoid gain

**Prompt.** “Teach a beginner what increasing the gain of a sigmoid does. Animate a gentle S-curve becoming a steep switch, show why the midpoint stays fixed, and relate one point on each side to the formula.”

A fresh author started from [the preceding PR](https://github.com/gaojude/drawcast/pull/10), commit `02c45c9`. Its only Drawcast references were the repository skill and the local CLI. It chose a built-in voice, the default canvas and the default 1080p30 video. The model was installed and none of the sentences were cached. The authored [six-step lesson](sample.drawcast.json) rendered on its first attempt.

## Timed trace

The task lasted **181.059 s** from 04:02:28.283 to 04:05:29.342 UTC on 2026-11-27. This includes the agent's visual inspection and final report. The process stopwatch measured **14.125 s** for the 46.03 s MP4. The [machine-readable trace](tools.jsonl) includes every tool input, return time, and result or output excerpt.

| Elapsed (s) | Operation and observation |
| ---: | --- |
| 5.575 | Read the skill, request CLI help and check clock. The author later identified the initial help call as redundant. |
| 10.936 | Read the quick start. |
| 15.900 | Open plots, math, elements, layout and narration in five processes. Elements included the plots and math sections a second time. |
| 38.565 | Open actions and look for FFmpeg on PATH. |
| 78.137 | Write the lesson. The axes alone use two arrows, four tick marks, six numeric labels and two titles. |
| 83.262 | Validate and draw the contact sheet in 1.196 s. Estimated duration was 54.9 s. |
| 88.380 | Inspect sheet. All six steps were legible with no layout revision. |
| 97.544 | Start render. The author uses `p` to animate a single curve from gain 1 to gain 4. |
| 116.050 | Search the data directory for ffmpeg and ffprobe. |
| 124.153 | Probe installed Node dependencies and locate ffmpeg-static. |
| 134.324 | Collect the completed render. Duration was about 8.9 s shorter than the preview estimate. |
| 148.168 | Decode nine samples of the MP4 with FFmpeg. |
| 153.275 | Inspect decoded frames. The midpoint stays fixed, the curve steepens smoothly, and both marked values match the formulas. |
| 163.288 | Read clock before final report. |

## Changes tested

The new `axes` element takes tick values in the same domain and range as a plotted line. It replaces all fourteen manually positioned parts of this graph. The new `inspect` command extracts real frames from the finished MP4 with the bundled FFmpeg. The snapshot diagnostic now explains that a fresh estimate can move by several seconds.

The guide accepts multiple topics in one invocation and prints each once. To isolate the lookup change, we replayed the six topics on the previous CLI and a build with only the new guide dispatch and section headings. Across five alternating trials, running the six old commands sequentially took 1.205, 1.209, 1.435, 1.373 and 1.282 s. The single combined call took 0.215, 0.203, 0.230, 0.299 and 0.205 s. Output fell from 5,400 to 4,089 tokens with o200k_base. The actual author ran the first five lookups concurrently, so the sequential difference describes CLI startup cost rather than a measured reduction in the author's elapsed time.

[Narrated walkthrough](walkthrough.mp4) · [Walkthrough source](walkthrough.drawcast.json) · [Decoded frame used in the walkthrough](gain-at-22.png)
