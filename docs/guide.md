# Make a Drawcast video

Use the same CLI invocation that printed this guide for the commands below.

1. Write a `lesson.drawcast.json`. Give each spoken idea a visible change.
2. Run `drawcast render lesson.drawcast.json`. It checks the script, speaks the narration and writes the MP4. To try a layout before rendering, use `drawcast snapshot lesson.drawcast.json --sheet`.
3. Review the encoded steps with `drawcast inspect lesson.mp4 --step all` and return the MP4. For movement use `--motion`, or compare exact times with `--at 2,2.5,3`.

Video defaults to 1080p at 30 fps. Set `--width` and `--fps` on render. On an inspection sheet, `--width` sets each tile's width. Inspect prints encoded dimensions, duration, frame count, average fps and audio codec. Speech is cached. For offline English use `"voice":"maple"`.

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
| `script` | Canvas background and size, voice, speed, captions and cover |
| `plots` | Function curves, moving parameters, markers that follow a path |
| `math` | Typeset LaTeX, animate a derivation |
| `elements` | Shapes, lines, arrows, images, text, colours and fonts |
| `actions` | Motion along a path, simultaneous actions, camera, signals |
| `layout` | Spacing, overlap, label and caption clearance |
| `narration` | Voice, language, offline speech and pronunciation |
| `full` | Complete script reference and longer worked example. Includes every topic. |
