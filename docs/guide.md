# Make a Drawcast video

Use the same CLI invocation that printed this guide for the commands below.

1. Write a `lesson.drawcast.json`. Give each spoken idea a visible change.
2. Run `drawcast snapshot lesson.drawcast.json --sheet`. It validates the script and prints layout diagnostics and a PNG path. Inspect the sheet. Revise if needed. For a moving detail use `--at <seconds>`; timing becomes exact after rendering.
3. Run `drawcast render lesson.drawcast.json` and return the MP4. To inspect the encoded frames, run `drawcast inspect lesson.mp4` (add `--at <seconds>` for one frame). Defaults are 1080p at 30 fps on the default canvas. `--width` and `--fps` change delivery size and frame rate. Speech is cached. Leave `voice` unset for the default online voice with local fallback, or choose a built-in voice for offline narration.

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

Copy `at` phrases from the step's `say` in spoken order. Repeat a phrase to start actions together. With no `at`, an action follows the preceding one. Put `duration` (seconds) beside the action verb. Use `update` to change an existing object's position, colour or label, `pulse` for emphasis, `point` for a pointer and `remove` to clear space.

Request the topics your scene needs together, e.g. `drawcast guide plots math elements`. Topics print once in the order listed.

| Topic | Use it for |
| --- | --- |
| `plots` | Function curves, moving parameters, markers that follow a path |
| `math` | Typeset LaTeX, animate a derivation |
| `elements` | Shapes, lines, arrows, images, text, colours and fonts |
| `actions` | Motion along a path, simultaneous actions, camera, signals |
| `layout` | Spacing, overlap, label and caption clearance |
| `narration` | Voice, language, offline speech and pronunciation |
| `full` | Complete script reference and longer worked example. Includes every topic. |
