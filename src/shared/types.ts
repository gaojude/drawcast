/** The drawcast file format, version 1. `docs/format.md` is the prose description of the same thing. */

export type Point = [number, number];

export type ElementType = "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line" | "freedraw" | "image";

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
  fontSize?: number;
  fontFamily?: FontName;
  textAlign?: "left" | "center" | "right";
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

export type VoiceSpec = string | { clip: string; transcript: string };

export interface Script {
  drawcast: 1;
  title?: string;
  canvas?: { width?: number; height?: number; background?: string };
  /** A built-in voice name, or a short clip of a voice to imitate. */
  voice?: VoiceSpec;
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
