# Author run 7 · Sliding tiles

**Prompt.** Teach the sliding-tile rule on a two-by-two board. Start with 1 and 2 on top, 3 at lower left and the hole at lower right. Slide 2 down and then 1 right. Explain why the second move becomes possible and keep all tile identities legible.

A fresh author started from PR #17 at `4e57a63`. The trial ran from 05:23:19.313 to 05:25:57.914 UTC on 2026-11-27, **158.601 s** including inspection and reporting. The first draft used named shape centers for all three tiles and both routes. It opened on the requested board. Rendering the 18.8 s lesson took **6.02 s** for 564 frames and eight uncached Maple sentences.

| Elapsed | Action and result |
| ---: | --- |
| 5–18 s | Read the skill, quick start and one combined topic lookup. |
| 36–65 s | Checked the destination and wrote the four-step script. |
| 70–78 s | Previewed all four states on one sheet. |
| 84–94 s | Rendered the first draft once. |
| 99–106 s | Inspected the encoded sheet. Six uniformly spaced frames missed both slides in progress. |
| 117–140 s | Guessed two times, decoded two more images and verified each tile mid-slide. |

## Change and measurement

`drawcast inspect sample.mp4 --motion` takes one extra low-resolution pass over the encoded frames. It ignores the bottom caption region when scoring, looks for change across consecutive frames to avoid selecting a single cut, and chooses up to four separated peaks between the first and last frames. The output shows the original frames with captions. Most visible change wins, so smaller simultaneous actions can still require an exact timestamp.

On the author's MP4, the resulting sheet shows the orange 2 descending at **7.933 s** and blue 1 moving right at **14.167 s**. All frames came from the same original MP4. The guide directs movement reviews to this option.

| Same-file replay | Pass 1 | Pass 2 | Pass 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Uniform sheet plus two exact frames | 1.496 s | 1.481 s | 1.491 s | 1.491 s |
| Motion sheet | 1.071 s | 0.911 s | 1.007 s | 1.007 s |

Process timings include CLI startup, FFmpeg and PNG output, and exclude time spent choosing timestamps and opening images. The build, typecheck and all 133 tests passed. The command-level trace is available in the workspace as `tools.local.jsonl`.

[Sample video](sample.mp4) · [Original inspection](sample.inspect.png) · [Motion inspection](sample.inspect.motion.png) · [Narrated walkthrough](walkthrough.mp4)
