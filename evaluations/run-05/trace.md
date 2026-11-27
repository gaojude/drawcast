# Author run 5 · A lost acknowledgment

**Prompt.** “Make a short narrated explainer for a new engineer about an acknowledgment lost in transit. Show a sender transmitting order 42, the receiver recording it once, the acknowledgment being lost, and then the sender retrying. Make it clear why the receiver returns an acknowledgment without recording the order twice.”

A fresh author worked from [PR #13](https://github.com/gaojude/drawcast/pull/13) at `a31422e`. Its Drawcast references were the repository skill and the checked-out CLI. The author finished in **135.988 s**. The 41.3 s, 1920×1080, 30 fps MP4 took **10.89 s** to render, including narration. The model was installed and the sentences were uncached. The default online voice failed its executable check and the automatic fallback to Maple finished the job.

## Timed trace

| Elapsed (s) | Action and result |
| ---: | --- |
| 5.359 | Read the skill. |
| 9.331 | Read the quick start. |
| 13.091 | Request elements, actions, narration, and layout together. |
| 60.387 | Write the five-step script. |
| 64.974 | Validate and draw the contact sheet. No errors or layout warnings. |
| 70.360 | Inspect all five layouts and proceed with the first draft. |
| 77.472 | Start the only render. |
| 92.689 | Collect the process result, 1,241 frames. |
| 99.342 | Use `inspect` on the delivered MP4. |
| 104.285 | Inspect six decoded frames, including the lost acknowledgment, retry, and successful reply. |
| 116.512 | Request a sheet with exact narration-based times for the evaluation report. |
| 124.280 | Read the five completion times. |

## Stopping decision

**Zero actionable findings for this prompt.** The diagram distinguishes the failed red acknowledgment from the successful green reply. It carries the same order ID through the retry. The receiver's order book still contains a single entry when the sender is acknowledged. Captions clear the drawing.

The author used one combined topic lookup, the standard validating preview, one render, and the built-in decoded-frame inspection. Exact step times for the report were available from the cached speech. There were no repair attempts, external encoder searches or changes needed to the CLI or skill. The terminal PR records the evidence and walkthrough.

[Watch the actual lesson](sample.mp4) · [Sample source](sample.drawcast.json) · [Tool trace](tools.jsonl) · [Narrated evaluation walkthrough](walkthrough.mp4)
