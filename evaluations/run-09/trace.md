# Author run 9 · Typing after Undo

**Prompt.** Make a short narrated video explaining why typing after Undo clears Redo in a plain text editor. Start with CAT, append S, undo the S, then append a different letter. Show the visible document and its available history, including when redo is possible and when that former version is discarded.

A fresh author used the shipped skill and CLI from PR #19 at `bf86a9f`. The trial took **195.182 s**, from 05:45:06.520 to 05:48:21.702 UTC on 2026-11-27. The 30.9 s lesson contained 929 frames. Local voice fallback succeeded, with eleven cache misses on the first render and eleven hits on the second.

| Elapsed | Author action and outcome |
| ---: | --- |
| 7–19 s | Read the skill, quick start and topics on elements, actions, layout and narration. |
| 36 s | Opened the full guide to find the step-level pause. |
| 85–103 s | Wrote and previewed the five-step lesson. Each of two state transitions required six actions carrying the same cue. |
| 110–128 s | Rendered in 8.54 s and decoded the motion sheet. At 18.333 s the document showed CATX while the corresponding history label was nearly invisible halfway through its fade. |
| 150–177 s | Shortened the label transition to 0.03 s, rendered again in 4.25 s and verified eight exact instants in one sheet. |

## Changes

An `update` list now applies different changes to distinct targets at one cue. `duration: 0` changes the document text, history label and status on one frame. Without a duration, each update retains its default and the next uncued action waits for the longest member. The quick start includes grouped updates and the step-level pause.

The walkthrough includes a crop of the original encoded mismatch, followed by an actual grouped transition. The browser timeline tests verify exact-frame changes and implicit scheduling. Build, typecheck and the full 138-test suite passed. The command-level author trace is retained locally as `tools.local.jsonl`.

[Corrected sample](sample.mp4) · [Original mismatch](before.png) · [Narrated walkthrough](walkthrough.mp4)
