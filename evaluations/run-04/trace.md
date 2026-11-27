# Author run 4 · Charging a capacitor

**Prompt.** “Explain to an introductory physics student why a capacitor connected through a resistor to a five-volt source charges quickly at first and then levels off. Plot these measured voltages at successive seconds: (0,0), (1,3.2), (2,4.3), (3,4.75), (4,4.9). Show which interval gains the most voltage, and connect it to the shrinking voltage across the resistor.”

A fresh agent used the skill and built CLI from [PR #12](https://github.com/gaojude/drawcast/pull/12), commit `c3145ab`. The separate follow-up on that PR concerned moving axes along rotated paths. These axes are stationary. The author chose Maple after checking installed voices. All 12 sentences were uncached.

The author took **220.273 s**, including time to reproduce and measure the diagnostics after delivering the 41.3 s, 1080p30 video. The render itself took **11.35 s**. All five readings were correctly placed and the first interval was visibly distinguished in the finished MP4.

## Timed trace

The [full tool trace](tools.jsonl) contains all 20 invocations. The initial draft was saved separately so the checker can be replayed against the exact input that produced the warnings.

| Elapsed (s) | Action and result |
| ---: | --- |
| 7.409–16.114 | Read the skill, help and quick start, request relevant topics in one process, and check available voices. |
| 58.913 | Write six steps using measured-point references, labels, the five-volt source line and bars for resistor voltage. |
| 63.616–89.759 | Generate and inspect the first sheet, then report suspect warnings about the text width and axes boundary. |
| 99.357–116.383 | Save the first sheet, revise three placements/labels, and inspect the new warning-free sheet. |
| 121.418–142.328 | Render 1,240 frames and collect the process result. |
| 149.362–165.177 | Preserve the first draft, decode a contact sheet with `inspect`, and review the encoded frames. |
| 179.792–209.029 | Inspect file timestamps, measure the original preview's pixels, replay the original checker and report the measurements. |

## Findings

The baseline checker predicted x=1283 as the right edge of “Current = resistor voltage / resistance”. Measured on the rendered tile, its rightmost ink was at approximately x=1157.5. The fixed-width estimate ignored the proportions of the default normal Latin font. The checker also treated an axes image's entire bounding rectangle as an obstacle for a label that crossed the edge in empty space. The preview revealed three warnings worth investigating, including another label near the x-axis title.

Replay with `node dist/cli.js check evaluations/run-04/first-draft.drawcast.json`. The walkthrough illustrates the original measurements and the new handling of axes and type. The font measurement here applies to normal-font ASCII text. Other font families retain their existing estimates.

On this replay the corrected checker estimates the formula's right edge at x≈1160.5. It drops the spurious formula and plotted-value warnings and retains the gain cue's contact with the x-axis title. The delivered revision checks clean.

[First draft](first-draft.drawcast.json) · [Delivered script](sample.drawcast.json) · [Narrated walkthrough](walkthrough.mp4) · [Walkthrough source](walkthrough.drawcast.json)
