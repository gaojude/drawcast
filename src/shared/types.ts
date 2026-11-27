/** The drawcast file format, version 1. `docs/format.md` is the prose description of the same thing. */

export type Point = [number, number];
export type ShapeCenter = [string];
export const isShapeCenter = (v: unknown): v is ShapeCenter => Array.isArray(v) && v.length === 1 && typeof v[0] === "string";

export type ElementType = "rectangle" | "ellipse" | "diamond" | "text" | "math" | "arrow" | "line" | "freedraw" | "image" | "axes";

export type FontName = "hand" | "normal" | "code";

/** Style properties, named as Excalidraw names them. */
export interface Style {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  /** 0 = clean lines, 1 = hand-drawn (default), 2 = very sketchy */
  roughness?: number;
  /** 0..100 */
  opacity?: number;
  /** radians, clockwise */
  angle?: number;
  /** A colour by name: sets `strokeColor`, and on a shape `backgroundColor` too, from the palette. */
  color?: ColorName;
}

/** Excalidraw's palette: a stroke and a fill of each colour, which look right together. */
export const PALETTE = {
  red: ["#e03131", "#ffc9c9"],
  orange: ["#e8590c", "#ffd8a8"],
  yellow: ["#f08c00", "#ffec99"],
  green: ["#2f9e44", "#b2f2bb"],
  teal: ["#099268", "#96f2d7"],
  blue: ["#1971c2", "#a5d8ff"],
  violet: ["#6741d9", "#d0bfff"],
  pink: ["#c2255c", "#fcc2d7"],
  // darker than Excalidraw's gray stroke, which as a label on the gray fill is hard to read
  gray: ["#495057", "#e9ecef"],
  black: ["#1e1e1e", "#e9ecef"],
} as const;

export type ColorName = keyof typeof PALETTE;

export interface ElementSpec extends Style {
  id: string;
  type: ElementType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** rectangle, diamond: rounded corners (default true). arrow, line: curve through the points. */
  rounded?: boolean;
  /** Text typed inside a shape, or on an arrow. */
  label?: string;
  /** text: the content; `\n` breaks lines. */
  text?: string;
  /** math: the formula, in LaTeX. */
  tex?: string;
  fontSize?: number;
  fontFamily?: FontName;
  /** text: how its lines are aligned. text, math: also which point `x` is, the left edge, the middle or the right edge. */
  textAlign?: TextAlign;
  /** arrow: an element id to attach to, or a point. */
  from?: string | Point;
  to?: string | Point;
  /** arrow: points the path passes through between its ends. */
  via?: Point[];
  startArrowhead?: Arrowhead | null;
  endArrowhead?: Arrowhead | null;
  /** line, freedraw: the path, in canvas coordinates. */
  points?: Point[];
  /** Expanded plots only: indices where the pen lifts to begin a new visible stretch. */
  breaks?: number[];
  /** line: join the last point to the first, so that `backgroundColor` fills it. */
  closed?: boolean;
  /** image: a file path relative to the script. */
  src?: string;
  /** line: a function of x to plot, such as "x^2 / 4", drawn across the box x, y, width, height. */
  fn?: string;
  /** Plot parameter in fn, animated by update.p on the same fixed axes. */
  p?: number;
  /** line with `fn`: the x values the box spans, [from, to]. */
  domain?: [number, number];
  /** line with `fn`: the y values the box spans, [bottom, top]. Default: as far as the curve goes. */
  range?: [number, number];
  /** axes: positions in data units and titles for the two linear scales. */
  xTicks?: number[];
  yTicks?: number[];
  xLabel?: string;
  yLabel?: string;
  /** How this element appears, when it is not the action's `enter`. */
  enter?: Enter;
  /** Place the middle on a shape center [id], a function value [plot,x] or a reading [axes,x,y]. */
  on?: ShapeCenter | [string, number] | [string, number, number];
}

export type Arrowhead = "arrow" | "triangle" | "bar" | "dot";

export type TextAlign = "left" | "center" | "right";

/** How far left of its `x` an element of this width starts. */
export const alignOffset = (width: number, align: TextAlign | undefined) => (align === "center" ? width / 2 : align === "right" ? width : 0);

export type Enter = "draw" | "fade" | "none";

/** Properties an `update` may change. */
export interface UpdateSpec extends Style {
  id: string | string[];
  /** Target value of the parameter of a plotted function. */
  p?: number;
  x?: number;
  y?: number;
  /** Move relative to where the element is now. */
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
  /** text elements: replace the content. */
  text?: string;
  /** math elements: replace the formula. */
  tex?: string;
  /** shapes and arrows that were added with a label: replace it. */
  label?: string;
  /** text and math elements: grow or shrink. */
  fontSize?: number;
  /** Travel along a path to its end: the id of an arrow or line, or points [[x, y], ...]. The element's middle follows it. */
  along?: string | Point[];
  /** Expanded routes only: indices where travel jumps across a clipped portion of a plot. */
  breaks?: number[];
  /** with `along`: the part of the path to travel, as fractions of its length (default [0, 1]). */
  span?: [number, number];
}

export type CameraSpec =
  | "reset"
  | { x: number; y: number; width: number }
  | { fit: "all" | string[]; padding?: number };

export interface Action {
  /**
   * When the action starts: a phrase copied from the step's `say` (it starts as that phrase is spoken),
   * or seconds from the start of the step. Left out, it follows the previous action.
   */
  at?: string | number;
  /** Seconds the animation takes. Each action has a sensible default. */
  duration?: number;
  add?: ElementSpec | ElementSpec[];
  /** How added elements appear: drawn stroke by stroke (default), faded in, or at once. */
  enter?: Enter;
  /** Distinct changes in a list start together. */
  update?: UpdateSpec | UpdateSpec[];
  remove?: string | string[];
  camera?: CameraSpec;
  /** Laser pointer: circles an element or a point for a moment, leaving no mark. */
  point?: string | Point;
  /** A glowing dot runs along each arrow or line, start to end, leaving no mark: a message, a request, a signal. */
  send?: string | string[] | { along: string | string[]; color?: ColorName | string; reverse?: boolean };
  /** Elements swell for a moment and settle back, to draw the eye: a heartbeat, a change, "this one". */
  pulse?: string | string[];
}

export interface Step {
  /** Narration, spoken while the step's actions play. */
  say?: string;
  do?: Action[];
  /** Seconds of silence after the step. */
  pause?: number;
  /** For a step without `say`: how long it lasts (default: as long as its actions take). */
  duration?: number;
}

export interface Script {
  drawcast: 1;
  title?: string;
  canvas?: { width?: number; height?: number; background?: string };
  /** A voice name from `drawcast voices`. */
  voice?: string;
  /** Speaking rate, 1 = normal. */
  speed?: number;
  /** Burn the narration into the picture as captions (default true). */
  captions?: boolean;
  /** The step whose finished canvas is the first frame of the video (default 1), or false for no cover. */
  cover?: number | false;
  steps: Step[];
}

/**
 * The canvas is small on purpose: Excalidraw's own sizes (20 px text, 2 px strokes) are meant for a
 * screen about this big. The video is rendered at OUTPUT_SCALE times the canvas, 1920 x 1080 by default.
 */
export const DEFAULT_CANVAS = { width: 1280, height: 720, background: "#ffffff" };
export const OUTPUT_SCALE = 1.5;

/** A formula typeset from LaTeX. */
export interface Formula {
  /** An SVG picture of it, drawn in `currentColor`. */
  svg: string;
  /** Its size in em: times the font size, the size on the canvas. */
  width: number;
  height: number;
}

/** The size the picture of a formula says it has, which an image needs. It is drawn as large as it is shown. */
export const MATH_PIXELS_PER_EM = 100;

/** When a spoken token starts, in seconds from the start of its step. */
export interface TimedToken {
  token: string;
  t: number;
}

/** What the renderer knows about a step's audio. */
export interface StepAudio {
  duration: number;
  tokens: TimedToken[];
  /** Caption lines with the span of the step's audio they are shown for. */
  captions: { text: string; t0: number; t1: number }[];
}
