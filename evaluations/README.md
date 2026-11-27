# Timed Drawcast author trials

Five fresh authors used the local CLI and the skill shipped with it. Each ran a different prompt, made a narrated MP4 and inspected it. The first trial started at `48814b6` on main. Each later trial started from the preceding PR. The fifth produced zero actionable findings for its prompt.

| Trial | Author wall time | Render wall time | Outcome | Evidence |
| --- | ---: | ---: | --- | --- |
| [1 · Wave interference](run-01/trace.md) | 184.253 s | 12.444 s | Animated plot parameters, a shorter guide and less scene serialization | [Video](run-01/walkthrough.mp4) · [Trace](run-01/tools.jsonl) |
| [2 · Sigmoid gain](run-02/trace.md) | 181.059 s | 14.125 s | Labeled axes, combined guide topics and inspection of the encoded MP4 | [Video](run-02/walkthrough.mp4) · [Trace](run-02/tools.jsonl) |
| [3 · Thermostat](run-03/trace.md) | 170.752 s | 12.050 s | Points and annotations expressed in chart coordinates | [Video](run-03/walkthrough.mp4) · [Trace](run-03/tools.jsonl) |
| [4 · Capacitor](run-04/trace.md) | 220.273 s | 11.350 s | Layout diagnostics distinguish visible axes and normal-font text widths | [Video](run-04/walkthrough.mp4) · [Trace](run-04/tools.jsonl) |
| [5 · Lost acknowledgment](run-05/trace.md) | 135.988 s | 10.890 s | First draft delivered, zero actionable findings | [Video](run-05/walkthrough.mp4) · [Trace](run-05/tools.jsonl) |

Author wall time runs from task start through the final report, including visual review and any requested diagnosis. The render column is a separate process stopwatch. The prompts and narration lengths differ. For a controlled speed comparison, see the [same-script A/B measurements and decoded-frame comparison](run-01/trace.md#renderer-timing).

The traces record timestamped tool inputs and outcomes. Long command outputs are excerpted, image payloads are represented by media type, and machine-specific paths and agent progress messages are abridged. Each directory contains the sample script and the matching narrated evaluation walkthrough. From a built checkout, render a script with `node dist/cli.js render evaluations/run-05/sample.drawcast.json`.

## Trials from v0.5.0

| Trial | Author wall time | Render process time | Outcome |
| --- | ---: | ---: | --- |
| [6 · Insertion sort](run-06/trace.md) | 209.672 s | 12.55 s + 4.64 s | Mark the first frame on the preview sheet and place tiles by the centers of named shapes. [Walkthrough](run-06/walkthrough.mp4) |
| [7 · Sliding tiles](run-07/trace.md) | 158.601 s | 6.02 s | Capture brief movements in one encoded inspection sheet. [Walkthrough](run-07/walkthrough.mp4) |
| [8 · Energy on a curved track](run-08/trace.md) | 168.615 s | 7.76 s | Compare exact instants in one decode and draw straight chords between plot points. [Walkthrough](run-08/walkthrough.mp4) |
| [9 · Typing after Undo](run-09/trace.md) | 195.182 s | 8.54 s + 4.25 s | Update distinct objects together on a single frame. [Walkthrough](run-09/walkthrough.mp4) |
| [10 · Undo and Redo replay](run-10/trace.md) | 143.499 s | 7.27 s | First draft delivered. Zero actionable findings on the repeated prompt. [Walkthrough](run-10/walkthrough.mp4) |
| [11 · Household budget](run-11/trace.md) | 154.900 s | 10.247 s | Percentage-based pie slices, focused guide topics, tile sizing and media details during inspection. [Walkthrough](run-11/walkthrough.mp4) |
| [12 · Budget replay](run-12/trace.md) | 103.854 s | 8.959 s | Continue a pie from the previous slice and find a complete narrated pie example in one topic. [Walkthrough](run-12/walkthrough.mp4) |
| [13 · Library acquisitions](run-13/trace.md) | 97.791 s | 9.146 s | Review encoded frames by step and reveal the unallocated part of a pie with one shared circle. [Walkthrough](run-13/walkthrough.mp4) |
