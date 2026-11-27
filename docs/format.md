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

Node.js 22.12 or newer is required. The first use of a built-in voice downloads a speech model
of about 365 MB. `drawcast setup` can download it ahead of time.

A snapshot needs no narration, so it is quick. Its timing is estimated until a render has spoken the
narration, and exact after that; it says which. `--at 12.5` shows the video at that moment, with the
pointer and the captions.

Leave `voice` unset unless the user asks for one (see Narration). The sheet marks the finished step
that appears as the MP4's first frame. Choose the opening you want with `cover`.
Speech is cached, so rendering again after changing
only the drawing is quicker. When a command fails, its message says what is missing.

## The script

| Property | |
| --- | --- |
| `drawcast` | `1`. Required. |
| `steps` | The list of steps, played in order. Required. |
| `title` | A name for the video. Not drawn. |
| `canvas` | `{ "width": 1280, "height": 720, "background": "#ffffff" }`, which is the default. |
| `voice` | A voice name from `drawcast voices`. Default: the online voice for the narration's language, or the first built-in one if it cannot be had. A name starting with `edge:` is an online voice (see Narration). |
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

```json
{ "at": "fails", "update": { "id": "server", "backgroundColor": "#ffc9c9", "strokeColor": "#e03131" } }
{ "update": { "id": ["a", "b"], "dx": 0, "dy": 120 } }
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
| `text` | `x`, `y`, `text` (`\n` breaks lines) | `fontSize`, `fontFamily`, `textAlign` |
| `math` | `x`, `y`, `tex` (a formula in LaTeX; see Math) | `fontSize`, `textAlign` |
| `arrow` | `from`, `to`: each an element id or a point `[x, y]` | `via`, `rounded`, `label`, `startArrowhead`, `endArrowhead` |
| `line` | `points`: `[[x, y], ...]`; or a plot (below) | `closed` (joins the ends, so `backgroundColor` fills it), `rounded` |
| `freedraw` | `points`: `[[x, y], ...]`, drawn as a smooth pen stroke through them | |
| `axes` | `x`, `y`, `width`, `height`, `domain`, `range` | `xTicks`, `yTicks`, `xLabel`, `yLabel`, `fontSize` (see Plots) |
| `image` | `x`, `y`, `src` (PNG, JPEG, GIF, WebP or SVG; path relative to the script) | `width`, `height` (default: the file's size and proportions) |

`x`, `y` is the top left corner. Points are in canvas coordinates. On a `text` or `math` element,
`"textAlign": "center"` makes `x` its middle and `"right"` its right edge, which places it without
knowing how wide it will be.

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
  get a warning.
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
- Left unset, the voice is one of Microsoft's online voices (`edge:zh-CN-XiaoxiaoNeural` for
  Chinese, `edge:en-US-EmmaMultilingualNeural` for English). They sound natural and say English and
  Chinese in one sentence without trouble, but the narration is sent to Microsoft and the `edge-tts`
  program must be installed. Without it, or without a connection, the built-in voice (`lin` or
  `maple`) says the whole script instead; `render` says which voice spoke. Name a built-in voice to
  keep the narration on this machine.

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
