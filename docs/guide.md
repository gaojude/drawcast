# Make a Drawcast video

Use the same CLI invocation that printed this guide for the commands below.

1. Ask which TTS setup to use for narrated videos. Check the project's agent notes for an existing choice. On first use, offer to help the user install local Kokoro, or use a model or hosted service they prefer. Run `drawcast guide narration` for setup and the file contract.
2. Write `lesson.drawcast.json`. Tie each spoken idea to a visible change. Use `drawcast snapshot lesson.drawcast.json --sheet` to review the layout.
3. Export `drawcast narration export lesson.drawcast.json -o request.json`. Read the sentence IDs and text, generate WAVs with the chosen tool, and write `result.json`. Keep the working TTS command, model, voice and rate in the project's agent notes for repeat runs.
4. Run `drawcast render lesson.drawcast.json --narration result.json -o lesson.mp4`. Review the MP4 with `drawcast inspect lesson.mp4 --motion` and return it to the user. For a silent script, omit `--narration`.

Video defaults to 1080p at 30 fps. Use `--width` and `--fps` on render.

```json
{
  "drawcast": 1,
  "steps": [
    {"say": "A sender prepares a message for the receiver.", "do": [
      {"at": "sender", "add": {"id": "a", "type": "rectangle", "x": 170, "y": 255, "width": 220, "height": 100, "label": "Sender", "color": "blue"}},
      {"at": "receiver", "add": {"id": "b", "type": "rectangle", "x": 890, "y": 255, "width": 220, "height": 100, "label": "Receiver", "color": "teal"}}
    ]},
    {"say": "The link carries the message across.", "do": [
      {"at": "link", "add": {"id": "link", "type": "arrow", "from": "a", "to": "b"}},
      {"at": "across", "send": "link"}
    ]}
  ]
}
```

Place elements on the 1280 by 720 canvas above y=620 for captions. A shape's x,y is its top left. Give it a unique id. Use `"on":["slot"]` to center it on an existing shape. Put static scenery in one `add` list with `"enter":"none"`.

The MP4 opens with the finished picture from step 1, marked **first frame** on the sheet. Set `cover` to another step number to open on that picture, or `false` to start directly with the animation.

Copy `at` phrases from `say` in spoken order. Without `at`, the action follows the previous one. Group different changes under one cue using an `update` list. Set `duration` to zero for an instant state change:

```json
{"at":"undo","duration":0,"update":[{"id":"doc","text":"CAT"},{"id":"status","label":"Redo available"}]}
```

Use `pulse` for emphasis, `point` for a pointer and `remove` to clear space. A step's `pause` adds seconds of silence at the end.

Start with the topic for your visual. For a pie chart, `drawcast guide pie` gives a complete narrated script. Combine topics when needed, e.g. `drawcast guide plots math`.

| Topic | Use it for |
| --- | --- |
| `pie` | Reveal labeled pie slices by percentage |
| `script` | Canvas background and size, captions and cover |
| `plots` | Function curves, moving parameters, markers that follow a path |
| `math` | Typeset LaTeX, animate a derivation |
| `elements` | Shapes, lines, arrows, images, text, colours and fonts |
| `actions` | Motion along a path, simultaneous actions, camera, signals |
| `layout` | Spacing, overlap, label and caption clearance |
| `narration` | Choose and remember a TTS setup, generate WAVs and a result JSON |
| `full` | Complete script reference and longer worked example. Includes every topic. |
