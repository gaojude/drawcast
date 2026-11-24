/** The drawcast file format, version 1. `docs/format.md` is the prose description of the same thing. */

export type Point = [number, number];

export type ElementType = "rectangle" | "ellipse" | "diamond" | "text" | "math" | "arrow" | "line" | "freedraw" | "image";

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
}

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
  /** line: join the last point to the first, so that `backgroundColor` fills it. */
  closed?: boolean;
  /** image: a file path relative to the script. */
  src?: string;
}

export type Arrowhead = "arrow" | "triangle" | "bar" | "dot";

export type TextAlign = "left" | "center" | "right";

/** How far left of its `x` an element of this width starts. */
export const alignOffset = (width: number, align: TextAlign | undefined) => (align === "center" ? width / 2 : align === "right" ? width : 0);

export type Enter = "draw" | "fade" | "none";

/** Properties an `update` may change. */
export interface UpdateSpec extends Style {
  id: string | string[];
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
  update?: UpdateSpec;
  remove?: string | string[];
  camera?: CameraSpec;
  /** Laser pointer: circles an element or a point for a moment, leaving no mark. */
  point?: string | Point;
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
