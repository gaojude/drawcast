# Author run 3 · Thermostat feedback

**Prompt.** “Make a short narrated explanation of negative feedback in a room thermostat. Show the relationship between the sensor, heater and room. Include a labeled temperature chart showing what happens when a door briefly lets cold air in, and why the heater eventually switches off.”

A fresh agent started from [PR #11](https://github.com/gaojude/drawcast/pull/11) at `e25765b` with the repository skill and the local CLI. The model and browser were installed and all 16 sentences were uncached. The built-in Maple voice took over when the local online voice executable failed its version check. The author delivered a six-step, 43.9 s, 1080p30 lesson in **170.752 s**, including a **12.05 s render**.

## Timed trace

The [tool trace](tools.jsonl) includes every author call and its return time. The [delivered script](sample.drawcast.json) preserves the original pixel coordinates.

| Elapsed (s) | Action and result |
| ---: | --- |
| 4.856 | Read the skill. |
| 9.151 | Read the default guide. |
| 15.818 | Read five relevant topics in one CLI call. |
| 63.930 | Write the feedback loop and chart. Four line segments hold sixteen hand-converted canvas positions. |
| 68.713 | Snapshot reports unsupported `roughness` on axes and a tight thermostat label. |
| 80.361 | Remove the unsupported style and enlarge the label's box. |
| 84.149 | Re-run the sheet successfully. |
| 89.997 | Inspect the step layouts. |
| 99.452 | Render at the default resolution/frame rate. |
| 115.816 | Collect the render result. |
| 124.644 | Use `inspect` directly on the MP4. |
| 130.293 | Inspect six decoded frames, including heater state, signal arrows, plot, and captions. |
| 145.649 | Snapshot again to report exact step times from the cached speech. |
| 155.567 | Read the exact step times off the sheet. |

## Findings

The chart grid already knew its domain and range. The author still had to calculate where 19 °C and 20 °C landed on the page for the curve, arrows, and pointer. The chart drew correctly at the original size, but moving it in the script would require editing the positions.

The new `["axesId", x, y]` notation lets a line, annotation, or pointer name a measurement on existing axes. It uses the same mapping in validation and rendering. The guide now lists the styles supported by axes next to the general style table. The label warning was actionable and the author corrected it directly.

[Narrated walkthrough](walkthrough.mp4) · [Walkthrough source](walkthrough.drawcast.json)
