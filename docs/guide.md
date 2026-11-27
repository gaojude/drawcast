# Make a Drawcast video

Use the same CLI invocation that printed this guide for the commands below.

1. Write a `lesson.drawcast.json`. Give each spoken idea a visible change.
2. Run `drawcast snapshot lesson.drawcast.json --sheet`. It validates the script and prints layout diagnostics and a PNG path. Inspect the sheet. Revise if needed. For a moving detail use `--at <seconds>`; timing becomes exact after rendering.
3. Run `drawcast render lesson.drawcast.json` and return the MP4. Defaults are 1080p at 30 fps on the default canvas. `--width` and `--fps` change delivery size and frame rate. Speech is cached. Leave `voice` unset for the default online voice with local fallback, or choose a built-in voice for offline narration.

```json
{
  "drawcast": 1,
  "cover": 2,
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

Place elements in canvas coordinates (1280 by 720 by default). Keep content above y=620 for captions. A shape's x,y is its top left. Give every element a unique id and add it before referring to it. Choose the step that best shows the whole idea for the 1-based `cover`.

Copy `at` phrases from the step's `say` in spoken order. Repeat a phrase to start actions together. With no `at`, an action follows the preceding one. Put `duration` (seconds) beside the action verb. Use `update` to change an existing object's position, colour or label, `pulse` for emphasis, `point` for a pointer and `remove` to clear space.

Look up only what your scene needs with `drawcast guide <topic>`:

| Topic | Use it for |
| --- | --- |
| `plots` | Function curves, moving parameters, markers that follow a path |
| `math` | Typeset LaTeX, animate a derivation |
| `elements` | Shapes, lines, arrows, images, text, colours and fonts |
| `actions` | Motion along a path, simultaneous actions, camera, signals |
| `layout` | Spacing, overlap, label and caption clearance |
| `narration` | Voice, language, offline speech and pronunciation |
| `full` | Complete script reference and longer worked example |
