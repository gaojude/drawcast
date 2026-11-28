# Writing a drawcast script

A drawcast script is a JSON file that says what to draw on an Excalidraw canvas and what to say while
drawing it. `drawcast render` turns it into an MP4: the narration is spoken by a local voice, and each
element is drawn at the moment the narration reaches the words you tie it to.

```json
{
  "drawcast": 1,
  "steps": [
    {
      "say": "Take a client and a server. Every page load begins with a request from one to the other.",
      "do": [
        { "at": "client", "add": { "id": "client", "type": "rectangle", "x": 140, "y": 280, "width": 220, "height": 110, "label": "Client" } },
        { "at": "server", "add": { "id": "server", "type": "rectangle", "x": 900, "y": 280, "width": 220, "height": 110, "label": "Server" } },
        { "at": "request", "add": { "id": "request", "type": "arrow", "from": "client", "to": "server", "label": "GET /" } }
      ]
    }
  ]
}
```

## Making a video

Follow `drawcast guide` for the authoring workflow. Use the same CLI invocation throughout.
`snapshot --sheet` reports errors and layout warnings and draws up to twelve steps per sheet.
`check` gives the same diagnostics without opening a browser. The shaded strip on the sheet
shows the caption area. Use `--step 4,7` to look more closely at selected steps.

After rendering, `drawcast inspect lesson.mp4 --step all` samples the encoded frame at each
step's finish using the actual narration schedule stored in the MP4. Select a step, list or range
with `--step 3`, `--step 2,5` or `--step 2-5`. When steps overlap, inspection prefers the
last available frame before the next step starts. Closely spaced steps can share a frame.
The final step shows the last frame of the MP4, including its final hold. Inspection prints the
step and timestamp for each tile and splits long selections across sheets.
Older Drawcast videos and other MP4s can be inspected by timestamp or motion.

`drawcast inspect lesson.mp4 --motion` saves a sheet with the first and last
frames and up to four moments of sustained change above the caption strip. It prints their times
in reading order. In a movie with a step index, the sheet also shows the completed step following
each sampled movement. Use `--at 2.5` for a full-size frame or `--at 2,2.5,3` to compare up to twelve
times in one sheet. Tiles show distinct frames in chronological order.

Node.js 22.12 or newer is required. The first use of a built-in voice downloads a speech model
of about 365 MB. `drawcast setup` can download it ahead of time.

A snapshot needs no narration, so it is quick. Its timing is estimated until a render has spoken the
narration, and exact after that; it says which. `--at 12.5` shows the video at that moment, with the
pointer and the captions.

Leave `voice` unset unless the user asks for one (see Narration). The sheet marks the finished step
that appears as the MP4's first frame. Choose the opening you want with `cover`.
Speech is cached, so rendering again after changing
only the drawing is quicker. When a command fails, its message says what is missing.

Render reports total elapsed time plus wall times for speech preparation and synthesis, and for
encoding and muxing. Speech and video can run together, so the phase times can overlap.

## Script

| Property | |
| --- | --- |
| `drawcast` | `1`. Required. |
| `steps` | The list of steps, played in order. Required. |
| `title` | A name for the video. Not drawn. |
| `canvas` | `{ "width": 1280, "height": 720, "background": "#ffffff" }`, which is the default. |
| `voice` | A voice name from `drawcast voices`. Defaults to local narration in English or Mandarin. A name starting with `minimax:` selects a paid MiniMax voice (see Narration). |
| `speed` | Speaking rate, 0.5 to 2. Default 1. |
| `captions` | `false` leaves the narration out of the picture. Default `true`. |
| `cover` | The number of the step whose finished canvas is the cover. Default `1`. `false` for no cover. |

The canvas is 1280 x 720 units and the video is 1920 x 1080 pixels, so everything is drawn 1.5 times
its size. Excalidraw's own defaults (20 px text, 2 px lines) are the right size at this scale. `x` grows
to the right and `y` grows downward, from the top left corner. Captions cover the bottom 14% of the
picture (below y 620 on the default canvas), so keep drawings above that.

The first frame of the video is the cover: the canvas once the `cover` step is done, without captions.
It is what a player or a feed shows before the video plays, and `snapshot --step` of that step shows
it. From the second frame on the canvas starts empty and everything is drawn in, so `--at 0` is blank.

## Steps

A step is one thing said and what happens on the canvas meanwhile.

| Property | |
| --- | --- |
| `say` | The narration, in English, Chinese, or both mixed. One to three sentences. |
| `do` | The list of actions. |
| `pause` | Seconds of silence after the step. |
| `duration` | For a step with no `say`: how long it lasts. Without it, the step lasts as long as its actions. |

Steps play one after another. A spoken step lasts as long as its narration takes; if its actions take
longer, the next step waits for them.

## Actions

An action is one of `add`, `update`, `remove`, `camera`, `point`, `send` or `pulse`, plus when it
happens. `at`, `duration` and `enter` sit on the action, beside the verb:

```json
{ "at": "rolls", "duration": 1.5, "update": { "id": "ball", "along": "curve" } }
```

| Property | |
| --- | --- |
| `at` | A word or short phrase copied from the step's `say`: the action starts as that phrase is spoken. Or a number: seconds from the start of the step. Left out, the action starts when the previous action ends (the first one, when the step starts). |
| `duration` | Seconds the animation takes. Every action has a sensible default. On an `add` of a list, each element takes that long. |

Actions are listed in the order they happen, so `at` phrases must appear in the order they are spoken.
Actions with the same `at` start together, which is how several things move at once: repeat the
phrase on each. When a phrase occurs twice in `say`, an `at` takes the first occurrence from the
previous action's phrase on, so a repeated `at` stays on the same one. Matching ignores case
and punctuation.

An arrow can only attach to elements that are already there. So word the narration to name both ends
before the connection: "the client sends a request to the server" cannot draw the request at
"sends", because the server is not on the canvas yet.

### add

Puts one element on the canvas, or several in turn when given a list.

```json
{ "at": "cache", "add": { "id": "cache", "type": "ellipse", "x": 500, "y": 300, "width": 200, "height": 100, "label": "Cache" } }
```

`enter` chooses how it appears: `"draw"` (the default: shapes are dragged out, lines grow from their
start, text is typed, formulas are written out), `"fade"`, or `"none"` (it is simply there). Put it on
the action for everything it adds, or on one element.

### update

Changes an element that is on the canvas, animated over 0.4 s. `id` is one id or a list.

Give `update` a list of changes to different targets to start them all together. Put `at` and
`duration` on the action. A duration of zero switches text, labels and colors in the same frame.

```json
{ "at": "fails", "update": { "id": "server", "backgroundColor": "#ffc9c9", "strokeColor": "#e03131" } }
{ "update": { "id": ["a", "b"], "dx": 0, "dy": 120 } }
{ "at": "undo", "duration": 0, "update": [{ "id": "doc", "text": "CAT" }, { "id": "status", "label": "Redo available" }] }
```

It can set `x`, `y`, `width`, `height` (shapes, text and images), `dx`, `dy` (a move relative to where
the element is; works on everything), any style property including `color`, `text` (text elements),
`fontSize` (text and math: it grows or shrinks), `tex` (math elements) and `label` (a shape or arrow added with one: the old words fade into the new).
Labels move with their shape, and arrows attached to a shape follow it.

`along` moves an element over a path instead of in a straight line: its middle travels from where it
is to the end of an arrow or line (by id; a plot too), or through points `[[x, y], ...]`. `span:
[0.2, 0.6]` travels only that part of the path, as fractions of its length. Default 1.2 s.

```json
{ "at": "rolls", "update": { "id": "ball", "along": "loss", "span": [0, 0.5] } }
```

### remove

Fades elements out. A shape's label goes with it. Arrows attached to it stay where they are, so remove
those too.

```json
{ "at": "gone", "remove": ["server", "request"] }
```

### camera

Moves the view, for a closer look or to another scene. Elements may be placed anywhere, past the
1280 x 720 of the picture; there is no need to make `canvas` larger.

```json
{ "camera": { "fit": ["cache", "server"], "padding": 80 } }
{ "camera": { "x": 0, "y": 720, "width": 1280 } }
{ "camera": "reset" }
```

`fit` takes a list of ids or `"all"`, and keeps them above the captions. With `x`, `y`, `width`, the
height follows from the canvas proportions. `"reset"` returns to the whole canvas.

### point

A laser pointer circles an element (by id) or a point `[x, y]` for a moment and leaves no mark. Use it
to direct the eye to something already drawn.

```json
{ "at": "this one", "point": "cache" }
```

### send

A glowing dot runs along an arrow or line from start to end and leaves no mark: a request, a message,
a heartbeat, a signal. Given a list, a dot runs along each at once. The default colour is red; name
another with `{ "along": [...], "color": "blue" }`, and `"reverse": true` runs it from the end back
to the start, for a reply. It takes about a second, by the path's length.

```json
{ "at": "asks", "send": "query" }
{ "at": "heartbeat", "send": { "along": ["hb2", "hb3", "hb4"], "color": "green" } }
```

### pulse

Elements (one id or a list) swell for a moment and settle back; on an arrow or line the stroke
thickens. For "this one changed", "this one answers". 0.6 s.

```json
{ "at": "answers", "pulse": "server" }
```

## Elements

Every element needs an `id`, unique in the script, and a `type`. Property names are Excalidraw's.

| Type | Needs | Also takes |
| --- | --- | --- |
| `rectangle`, `ellipse`, `diamond` | `x`, `y`, `width`, `height` | `label`, `rounded` (rectangle and diamond; default true) |
| `slice` | `share`, plus `center` and `radius` or `after` | `start` (percent, for explicit placement), `label`, `color`. See Pie. |
| `text` | `x`, `y`, `text` (`\n` breaks lines) | `fontSize`, `fontFamily`, `textAlign` |
| `math` | `x`, `y`, `tex` (a formula in LaTeX; see Math) | `fontSize`, `textAlign` |
| `arrow` | `from`, `to`: each an element id or a point `[x, y]` | `via`, `rounded`, `label`, `startArrowhead`, `endArrowhead` |
| `line` | `points`: `[[x, y], ...]`; or a plot (below) | `closed` (joins the ends, so `backgroundColor` fills it), `rounded` |
| `freedraw` | `points`: `[[x, y], ...]`, drawn as a smooth pen stroke through them | |
| `axes` | `x`, `y`, `width`, `height`, `domain`, `range` | `xTicks`, `yTicks`, `xLabel`, `yLabel`, `fontSize` (see Plots) |
| `image` | `x`, `y`, plus `src` (an image path) or `svg` (inline artwork) | `width`, `height` (default: the image's size and proportions) |

`x`, `y` is the top left corner. Points are in canvas coordinates. On a `text` or `math` element,
`"textAlign": "center"` makes `x` its middle and `"right"` its right edge, which places it without
knowing how wide it will be.

To reveal the result of an equation in a second color, place the two text elements on the same
`y`. Right-align the prefix at their join and start the result one space to its right.
For instance, `{"x":800,"y":320,"textAlign":"right","text":"9 − 6 ="}` pairs with
`{"x":810,"y":320,"text":"3"}`. Each part can have its own color and narration cue.

Use `["slot"]` as a point to refer to the center of a rectangle, ellipse or diamond already on the
canvas. For example, `"on":["slot"]` centers a new tile there. Move an existing tile between centers
with `{"update":{"id":"tile","along":[["tile"],["slot"]]}}`. Each point uses the position and size
set by preceding actions. An arrow with a string endpoint such as `"to":"slot"` follows its outline.

An arrow whose `from` or `to` is an id attaches to that element: it starts at the element's outline,
facing the other end, and follows when the element moves. `via` lists points the arrow passes through,
and `"rounded": true` turns the corners at those points into a curve. Arrowheads are `"arrow"`,
`"triangle"`, `"bar"`, `"dot"` or `null`; the default is an `"arrow"` at the end and nothing at the start.

A `label` is typed in the middle of a shape and wraps to its width (`\n` breaks it too), or sits on
the middle of an arrow.
`fontSize` (default 20; 16 on arrows) and `fontFamily` apply to labels too. Fonts are `"hand"` (the
default handwriting, which covers Chinese), `"normal"` and `"code"`.

For an illustrated object with several parts that travel together, put self-contained SVG markup
in one image. Its `viewBox` supplies the artwork's proportions, and the image element's dimensions
set its size on the board. Animate its id with `update.along`. Use `src` for a PNG, JPEG, GIF, WebP or SVG file
relative to the script. An inline book with its cover and spine can be written as:

```json
{"id":"book","type":"image","x":160,"y":260,"width":72,"height":96,"svg":"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 48'><rect x='1' y='1' width='34' height='46' rx='3' fill='#f0ab57'/><path d='M7 2v44' stroke='#69472d'/></svg>"}
```

### Style

Axes use clean vector strokes. Their style options are `color`, `strokeColor`, `strokeWidth`,
`opacity`, `angle` and `fontSize`. Omit `roughness` on axes.

| Property | Values | Default |
| --- | --- | --- |
| `color` | a colour name: sets `strokeColor`, and on a shape `backgroundColor` too, from the palette below | |
| `strokeColor` | hex colour | `"#1e1e1e"` |
| `backgroundColor` | hex colour or `"transparent"` | `"transparent"` |
| `fillStyle` | `"solid"`, `"hachure"`, `"cross-hatch"`, `"zigzag"` | `"solid"` |
| `strokeWidth` | 1 thin, 2 normal, 4 bold | 2 |
| `strokeStyle` | `"solid"`, `"dashed"`, `"dotted"` | `"solid"` |
| `roughness` | 0 clean, 1 hand-drawn, 2 sketchy | 1 |
| `opacity` | 0 to 100 | 100 |
| `angle` | radians, clockwise | 0 |

Excalidraw's palette, which looks right together, by name for `color`: `red`, `orange`, `yellow`,
`green`, `teal`, `blue`, `violet`, `pink`, `gray`, `black`. `"color": "blue"` is stroke `#1971c2` and
fill `#a5d8ff`; give `strokeColor` or `backgroundColor` as well to override either. A label is drawn in
its shape's stroke colour.

## Pie

Place the first slice with a `center` and `radius`. Give each following slice `after` with
the previous slice's id. It uses that circle and begins where its neighbor ends.
Each `share` is a percentage of the whole. To show the unallocated part during the reveal,
start with a neutral 100% slice and build the colored slices on top:

```json
{"drawcast":1,"voice":"maple","steps":[{"say":"The circle shows the whole team. Sales make up three quarters. Support accounts for one quarter.","do":[
  {"at":"circle","enter":"none","add":{"id":"whole","type":"slice","center":[540,320],"radius":205,"share":100,"color":"gray"}},
  {"at":"Sales","add":{"id":"sales","type":"slice","after":"whole","share":75,"color":"blue","label":"Sales\n75%"}},
  {"at":"Support","add":{"id":"support","type":"slice","after":"sales","share":25,"color":"teal","label":"Support\n25%"}}
]}]}
```

With explicit placement, `start` counts clockwise in percent from twelve o'clock (default 0).
A share of 100 makes a whole disk. A thin slice can use a separate text label or legend.

## Plots

A `line` with `fn` draws a function of x across the box `x`, `y`, `width`, `height`. `domain` is the
x values the box spans, left to right; `range` the y values, bottom to top (default: as far as the
curve goes; whatever leaves it is not drawn). Write `fn` as on paper: `x^2 / 4`, `2 sin(x) + 1`,
`exp(-x^2)`, `sigmoid(3x)`, with `sin cos tan exp ln log sqrt abs sigmoid relu`, `pi` and `e`.

For labeled axes, add an `axes` element before the curve. Give both the same `x`, `y`, `width`,
`height`, `domain` and `range`. Ticks are numbers in data units. The horizontal axis runs along
the bottom and the vertical axis along the left. Leave space outside the plot for their labels.

```json
{ "add": { "id": "scale", "type": "axes", "x": 137, "y": 184, "width": 600, "height": 334, "domain": [-3, 3], "range": [0, 1], "xTicks": [-1, 0, 1], "yTicks": [0, 0.5, 1], "xLabel": "input x", "yLabel": "output" } }
```

Tick lists and titles are optional. Axes are clean by default. Their styles are `fontSize`
(default 18), `color` or `strokeColor`, `strokeWidth`, `opacity` and `angle`.

Use `["scale", x, y]` for a reading in the axes' domain and range. Connect measured samples
directly, or use a reading in arrow endpoints and `via`, `point`, an `along` route, or a
marker's `on`. Each action resolves its coordinates at the position and angle set by preceding
actions. Move existing marks together with their axes by updating their ids together.

```json
{ "add": { "id": "readings", "type": "line", "points": [["scale", -1, 0.25], ["scale", 0, 0.5], ["scale", 1, 0.75]], "color": "teal" } }
{ "add": { "id": "last", "type": "ellipse", "on": ["scale", 1, 0.75], "width": 12, "height": 12, "color": "teal" } }
```

A point of the curve is named by the plot and its x: `["loss", -2.4]`. It goes wherever a point
`[x, y]` does: an arrow's `from`, `to` and `via`, a line's `points`, `point`, and `along`. Two points of
one plot in a row are the stretch of curve between them, so `"along": [["loss", -2.4], ["loss", 0]]`
rolls something down the curve. `"on": ["loss", -2.4]` in place of `x` and `y` puts a shape's middle
on the curve.

For a straight chord between two points on the same plot, use an arrow with its head removed.
For example, the following draws a level line between equal heights on a symmetric track.

```json
{ "add": { "id": "level", "type": "arrow", "from": ["track", -2.4], "to": ["track", 2.4], "endArrowhead": null, "strokeStyle": "dashed" } }
```

For a curve that changes shape, use a number named `p` in the expression. Set its initial
`p` and a fixed `range` on the plot. Animate `p` on the existing id, or target a list of
plots to vary them together. Drawcast evaluates the function at each intermediate value.
For example, use `sin(x+p)` for one wave and `sin(x)+sin(x+p)` for its sum with a fixed wave.
Plot coordinates used by later actions resolve at the preceding update's target value.

```json
{ "add": { "id": "wave", "type": "line", "fn": "sin(x+p)", "p": 0, "domain": [0, 6.283185], "range": [-1, 1], "x": 280, "y": 180, "width": 720, "height": 160 } }
{ "at": "shift", "duration": 2, "update": { "id": "wave", "p": 3.141593 } }
```

```json
{ "add": { "id": "loss", "type": "line", "fn": "x^2 / 4", "domain": [-3, 3], "range": [0, 2.5], "x": 340, "y": 200, "width": 600, "height": 300, "color": "blue", "strokeWidth": 3 } }
{ "add": { "id": "ball", "type": "ellipse", "on": ["loss", -2.4], "width": 24, "height": 24, "color": "red" } }
{ "at": "rolls", "update": { "id": "ball", "along": [["loss", -2.4], ["loss", -1]] } }
{ "add": { "id": "slope", "type": "arrow", "from": ["loss", -2.9], "to": ["loss", -1.9], "color": "violet" } }
```

## Math

A `math` element is a formula written in LaTeX, typeset the way a textbook prints it:

```json
{ "at": "sum", "add": { "id": "sum", "type": "math", "x": 640, "y": 200, "textAlign": "center", "fontSize": 32, "tex": "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}" } }
```

- Write every backslash twice. JSON takes a single one as an escape, so `"\frac"` and `"\theta"`
  are not what they look like. `drawcast check` names a formula it cannot typeset and says why.
- `tex` is the formula alone, with no `$` around it, set as a displayed equation. LaTeX's maths and
  the AMS additions are understood: fractions, roots, sums and integrals with limits, Greek letters,
  `\mathbb`, `\mathbf`, `\text{words}`, matrices, `cases`, and `aligned` or `\\` for several lines.
  `\textcolor{#e03131}{...}` colours one part. There are no equation numbers.
- `fontSize` is the size (default 20, which matches text; 28 to 40 suits a formula that is the
  subject of a step) and `strokeColor` the colour.
- `update` moves and recolours a formula like anything else, and `"tex"` replaces it, fading one
  formula into the next: a derivation is one element updated line by line.

```json
{ "at": "so", "update": { "id": "sum", "tex": "1 + 2 + \\dots + 100 = 5050", "strokeColor": "#2f9e44" } }
```

Text and labels are not LaTeX: `"label": "$\\alpha$"` is drawn as typed, and `check` warns about it.
Type the symbol itself instead, which works in any text, label and font: `α β θ λ π σ Δ Σ Ω`,
`→ ← ↔ ⇒`, `≤ ≥ ≠ ≈ ± × ÷ √ ∞ ∈ ∑ ∫ ∂ ∇`, `x² xₙ ½`. Use a `math` element when the notation
needs layout: a fraction, limits on a sum, a root over an expression, a matrix.

## Layout

`drawcast check` warns about layout it can measure, and `drawcast snapshot` shows the rest.

- Leave about 40 units between separate elements; `check` only warns when they overlap, so look.
- An element may sit fully inside another (parts inside a container). Two elements that half overlap
  get a warning. For an intentional layer such as a shelf plank over its back panel, review the
  image and keep the overlap if it draws the intended object.
- A label needs room: about 12 units per Latin letter and 20 per Chinese character at the default
  size, plus 20 of padding. Ellipses and diamonds hold less than their width suggests.
- A shape that contains other elements should not have a label, because the label sits in its middle.
  Put a `text` element near its top instead.
- A formula takes more room than its LaTeX suggests. At the default size a symbol is about 12 units
  wide; a line is about 20 tall, and 40 to 55 with a fraction or a sum in it. `check` measures the
  real thing, so its warnings about a formula are exact.
- Text is for names, values and short phrases. The narration is in the captions already.

## Making it vivid

A video holds attention when something on screen answers every sentence. Cheap ways to get there:

- **Colour means something.** Give each kind of thing a `color` (clients blue, servers violet, errors
  red) and keep it; change an element's colour when its state changes, rather than adding a note.
- **Show the motion the words describe.** A request travelling is a `send` along its arrow; a value
  moving is an `update` `along` a path; a change is a `pulse` or a colour change at the word that says
  it; a step-by-step change of a number or label is an `update` of `text` or `label`.
- **Build up, then take away.** Add parts as they are named; `remove` or dim (`opacity`) what the
  narration has moved past, so the eye goes to what is new.
- **Use `point` for "this one"** when nothing needs to move.
- **Use the camera for a second scene** rather than squeezing it in: draw it beside the first and
  `camera` `fit` it.
- Keep each scene to a handful of elements, with big type for what matters (`fontSize` 28 to 40 for
  a title or a key number).

## Narration

- Write for the ear: short sentences, plain words. What is said is also what the captions show.
- The voice does not read LaTeX, or symbols such as `=` and `²`. Say a formula in words ("x squared",
  "the sum from one to n") and show it in a `math` element.
- Numbers, percentages and years are read out. A short word in capitals (`API`, `DNS`, `JSON`) is
  spelled letter by letter; write it the way it sounds (`jason`) to have it read as a word. An English
  word the voice does not know is read by its spelling, which is usually close and sometimes wrong.
- English inside a Chinese sentence is less reliable than either language alone: about one such word
  in four comes out unclear. Keep to common terms, or say the term in Chinese and write the English
  on the canvas.
- A word's time within its sentence is estimated, so an `at` lands within about a quarter of a second
  of the word. The start of each sentence is exact.
- By default, Kokoro speaks locally using `maple` for English and `lin` for Mandarin. Setup downloads
  the model once. Remove the `voice` field from older scripts that specify an `edge:` voice.
- For environments that require local narration, use a built-in voice. An explicit MiniMax voice
  sends the narration to MiniMax. A custom `--tts-command` receives each sentence on stdin and can
  send it wherever that program is configured to send it.
- `minimax:<voice id>` (for example `minimax:male-qn-qingse`) is one of MiniMax's voices. They are
  the most expressive, but each character spoken is billed to the person's own MiniMax account, so use
  one only when asked to. A spoken sentence is cached, so a render again pays only for new sentences.
  It needs an API key, which never goes in the script or the conversation: if `drawcast voices`
  reports no key, ask the person to run `drawcast key minimax` (or `npx -y drawcast@latest key minimax`
  when drawcast is not installed globally) in their own terminal and paste the key there, then render. `@speech-2.8-turbo` after the voice id picks the cheaper model.

### External recordings

Run `drawcast narration export talk.drawcast.json -o request.json`. The version 1 request contains
a `fingerprint` and an ordered `steps` array. Each step has a `sentences` array, empty for a silent
step. Each sentence has an `id`, the exact `text` to speak, and the ordered `tokens` Drawcast uses
for phrase cues. Your TTS tool can synthesize each sentence, a whole step, or a longer take.
Choose the voice and speaking rate when making the WAVs.

Write a result JSON with the request's version and fingerprint and one entry per sentence ID.
Entries can arrive in any order. For example, a provider recording two sentences in one take
followed by a separate sentence could return this result (substitute the exported fingerprint):

```json
{
  "version": 1,
  "fingerprint": "<copy from request.json>",
  "sentences": [
    {"id": "s1.1", "audio": "step-1.wav", "startMs": 120, "endMs": 1080},
    {"id": "s1.2", "audio": "step-1.wav", "startMs": 1410, "endMs": 3020},
    {"id": "s2.1", "audio": "closing.wav"}
  ]
}
```

- `audio` identifies a PCM or floating-point WAV. Relative paths resolve beside the result JSON.
  For a sentence in its own file, omit both bounds and Drawcast uses its measured duration.
- For a range, supply both `startMs` (inclusive) and `endMs` (exclusive) in milliseconds from
  the start of the WAV. Drawcast keeps the audio between consecutive ranges in the same take
  and step. It drops audio outside the selected span. Separate clips in a step get a 280 ms gap.
  Drawcast schedules each step independently, including the script's animations and pauses.
- Optionally include `tokenStartsMs` on an entry, e.g. `[120, 410, 680]` for three exported tokens.
  These timestamps use the same file clock, fall inside the sentence, and follow token order.
  Without them, phrase cues use estimated token starts within the measured sentence.

Run `drawcast render talk.drawcast.json --narration result.json` for the MP4, or add the same
option to `snapshot` for a timed preview. Imported audio plays at its recorded speed. The
fingerprint lets you reuse recordings after visual edits and catches changes to the narration
text or its step grouping.

## A longer example

```json
{
  "drawcast": 1,
  "title": "Why a cache helps",
  "steps": [
    {
      "say": "Every time the app needs a user, it goes to the database and asks. And the database is slow.",
      "do": [
        { "at": "app", "add": { "id": "app", "type": "rectangle", "x": 120, "y": 260, "width": 200, "height": 100, "label": "App", "color": "blue" } },
        { "at": "database", "add": { "id": "db", "type": "rectangle", "x": 940, "y": 260, "width": 220, "height": 100, "label": "Database", "color": "gray" } },
        { "at": "asks", "add": { "id": "query", "type": "arrow", "from": "app", "to": "db", "label": "80 ms" } },
        { "at": "slow", "send": "query" }
      ]
    },
    {
      "say": "So we put a cache in between. It remembers the answers it has already seen.",
      "do": [
        { "at": "cache", "remove": "query" },
        { "add": { "id": "cache", "type": "ellipse", "x": 530, "y": 250, "width": 200, "height": 120, "label": "Cache", "color": "yellow" } },
        { "at": "remembers", "add": [
          { "id": "ask", "type": "arrow", "from": "app", "to": "cache", "label": "1 ms" },
          { "id": "miss", "type": "arrow", "from": "cache", "to": "db", "strokeStyle": "dashed", "label": "only on a miss" }
        ] },
        { "send": { "along": "ask", "color": "green" } }
      ],
      "pause": 0.5
    },
    {
      "say": "Most requests never reach the database at all.",
      "do": [
        { "at": "never", "update": { "id": ["db", "miss"], "opacity": 35 } },
        { "at": "database", "camera": { "fit": ["app", "cache"], "padding": 120 } }
      ]
    }
  ]
}
```
