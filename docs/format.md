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

Work in this loop:

1. Write the script, named `something.drawcast.json`.
2. `drawcast check file` lists errors and layout warnings. Fix them all.
3. `drawcast snapshot file` saves the finished canvas as a PNG (`--step 2` for the canvas as step 2
   ends). Look at it. You cannot judge a layout from coordinates alone.
4. `drawcast render file` speaks the narration and writes the MP4.

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

The canvas is 1280 x 720 units and the video is 1920 x 1080 pixels, so everything is drawn 1.5 times
its size. Excalidraw's own defaults (20 px text, 2 px lines) are the right size at this scale. `x` grows
to the right and `y` grows downward, from the top left corner. Captions cover the bottom 14% of the
picture (below y 620 on the default canvas), so keep drawings above that.

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

An action is one of `add`, `update`, `remove`, `camera` or `point`, plus when it happens:

| Property | |
| --- | --- |
| `at` | A word or short phrase copied from the step's `say`: the action starts as that phrase is spoken. Or a number: seconds from the start of the step. Left out, the action starts when the previous action ends (the first one, when the step starts). |
| `duration` | Seconds the animation takes. Every action has a sensible default. |

Actions are listed in the order they happen, so `at` phrases must appear in the order they are spoken.
When a phrase occurs twice, the first occurrence after the previous action's phrase is used. Matching
ignores case and punctuation.

An arrow can only attach to elements that are already there. So word the narration to name both ends
before the connection: "the client sends a request to the server" cannot draw the request at
"sends", because the server is not on the canvas yet.

### add

Puts one element on the canvas, or several in turn when given a list.

```json
{ "at": "cache", "add": { "id": "cache", "type": "ellipse", "x": 500, "y": 300, "width": 200, "height": 100, "label": "Cache" } }
```

`enter` chooses how it appears: `"draw"` (the default: shapes are dragged out, lines grow from their
start, text is typed), `"fade"`, or `"none"` (it is simply there).

### update

Changes an element that is on the canvas, animated over 0.4 s. `id` is one id or a list.

```json
{ "at": "fails", "update": { "id": "server", "backgroundColor": "#ffc9c9", "strokeColor": "#e03131" } }
{ "update": { "id": ["a", "b"], "dx": 0, "dy": 120 } }
```

It can set `x`, `y`, `width`, `height` (shapes, text and images), `dx`, `dy` (a move relative to where
the element is; works on everything), any style property, and `text` (text elements). Labels move with
their shape, and arrows attached to a shape follow it.

### remove

Fades elements out. A shape's label goes with it. Arrows attached to it stay where they are, so remove
those too.

```json
{ "at": "gone", "remove": ["server", "request"] }
```

### camera

Moves the view, for a canvas larger than the picture or for a closer look.

```json
{ "camera": { "fit": ["cache", "server"], "padding": 80 } }
{ "camera": { "x": 0, "y": 720, "width": 1280 } }
{ "camera": "reset" }
```

`fit` takes a list of ids or `"all"`. With `x`, `y`, `width`, the height follows from the canvas
proportions. `"reset"` returns to the whole canvas.

### point

A laser pointer circles an element (by id) or a point `[x, y]` for a moment and leaves no mark. Use it
to direct the eye to something already drawn.

```json
{ "at": "this one", "point": "cache" }
```

## Elements

Every element needs an `id`, unique in the script, and a `type`. Property names are Excalidraw's.

| Type | Needs | Also takes |
| --- | --- | --- |
| `rectangle`, `ellipse`, `diamond` | `x`, `y`, `width`, `height` | `label`, `rounded` (rectangle and diamond; default true) |
| `text` | `x`, `y`, `text` (`\n` breaks lines) | `fontSize`, `fontFamily`, `textAlign` |
| `arrow` | `from`, `to`: each an element id or a point `[x, y]` | `via`, `rounded`, `label`, `startArrowhead`, `endArrowhead` |
| `line` | `points`: `[[x, y], ...]` | `closed` (joins the ends, so `backgroundColor` fills it), `rounded` |
| `freedraw` | `points`: `[[x, y], ...]`, drawn as a smooth pen stroke through them | |
| `image` | `x`, `y`, `src` (PNG, JPEG, GIF, WebP or SVG; path relative to the script) | `width`, `height` (default: the file's size and proportions) |

`x`, `y` is the top left corner. Points are in canvas coordinates.

An arrow whose `from` or `to` is an id attaches to that element: it starts at the element's outline,
facing the other end, and follows when the element moves. `via` lists points the arrow passes through,
and `"rounded": true` turns the corners at those points into a curve. Arrowheads are `"arrow"`,
`"triangle"`, `"bar"`, `"dot"` or `null`; the default is an `"arrow"` at the end and nothing at the start.

A `label` is typed in the middle of a shape and wraps to its width, or sits on the middle of an arrow.
`fontSize` (default 20; 16 on arrows) and `fontFamily` apply to labels too. Fonts are `"hand"` (the
default handwriting, which covers Chinese), `"normal"` and `"code"`.

### Style

| Property | Values | Default |
| --- | --- | --- |
| `strokeColor` | hex colour | `"#1e1e1e"` |
| `backgroundColor` | hex colour or `"transparent"` | `"transparent"` |
| `fillStyle` | `"solid"`, `"hachure"`, `"cross-hatch"`, `"zigzag"` | `"solid"` |
| `strokeWidth` | 1 thin, 2 normal, 4 bold | 2 |
| `strokeStyle` | `"solid"`, `"dashed"`, `"dotted"` | `"solid"` |
| `roughness` | 0 clean, 1 hand-drawn, 2 sketchy | 1 |
| `opacity` | 0 to 100 | 100 |
| `angle` | radians, clockwise | 0 |

Excalidraw's palette, which looks right together:

| | Stroke | Fill |
| --- | --- | --- |
| red | `#e03131` | `#ffc9c9` |
| green | `#2f9e44` | `#b2f2bb` |
| blue | `#1971c2` | `#a5d8ff` |
| yellow | `#f08c00` | `#ffec99` |
| violet | `#6741d9` | `#d0bfff` |
| gray | `#868e96` | `#e9ecef` |

## Layout

`drawcast check` warns about layout it can measure, and `drawcast snapshot` shows the rest.

- Leave at least 40 units between elements that are not inside one another.
- An element may sit fully inside another (parts inside a container). Two elements that half overlap
  get a warning.
- A label needs room: about 12 units per Latin letter and 20 per Chinese character at the default
  size, plus 20 of padding. Ellipses and diamonds hold less than their width suggests.
- A shape that contains other elements should not have a label, because the label sits in its middle.
  Put a `text` element near its top instead.
- Text is for names, values and short phrases. The narration is in the captions already.

## Narration

- Write for the ear: short sentences, plain words. What is said is also what the captions show.
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
  `maple`) says the whole script instead. Name a built-in voice to keep the narration on this
  machine.

## A longer example

```json
{
  "drawcast": 1,
  "title": "Why a cache helps",
  "steps": [
    {
      "say": "Every time the app needs a user, it goes to the database and asks. And the database is slow.",
      "do": [
        { "at": "app", "add": { "id": "app", "type": "rectangle", "x": 120, "y": 260, "width": 200, "height": 100, "label": "App", "backgroundColor": "#a5d8ff" } },
        { "at": "database", "add": { "id": "db", "type": "rectangle", "x": 940, "y": 260, "width": 220, "height": 100, "label": "Database", "backgroundColor": "#e9ecef" } },
        { "at": "asks", "add": { "id": "query", "type": "arrow", "from": "app", "to": "db", "label": "80 ms" } },
        { "at": "slow", "point": "query" }
      ]
    },
    {
      "say": "So we put a cache in between. It remembers the answers it has already seen.",
      "do": [
        { "at": "cache", "remove": "query" },
        { "add": { "id": "cache", "type": "ellipse", "x": 530, "y": 250, "width": 200, "height": 120, "label": "Cache", "backgroundColor": "#ffec99" } },
        { "at": "remembers", "add": [
          { "id": "ask", "type": "arrow", "from": "app", "to": "cache", "label": "1 ms" },
          { "id": "miss", "type": "arrow", "from": "cache", "to": "db", "strokeStyle": "dashed", "label": "only on a miss" }
        ] }
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
