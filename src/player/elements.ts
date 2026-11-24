/** Building Excalidraw elements from the specs in a script. */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { type ElementSpec, MATH_PIXELS_PER_EM, type Point, type Style, alignOffset } from "../shared/types.ts";
import { type Pt, smooth } from "./motion.ts";

/** An Excalidraw element. Its shape is Excalidraw's business; we only touch the fields we set. */
export type El = Record<string, any>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_STROKE = "#1e1e1e";
/** Excalidraw font families: Excalifont (handwriting), Nunito, Cascadia (monospace). */
const FONT_FAMILY = { hand: 5, normal: 6, code: 3 } as const;
export const fontName = (family: number) => (Object.keys(FONT_FAMILY) as (keyof typeof FONT_FAMILY)[]).find((k) => FONT_FAMILY[k] === family) ?? "hand";
const LABEL_FONT_SIZE = 20;
const ARROW_LABEL_FONT_SIZE = 16;
/** Gap between an attached arrow and the outline it points at. */
const ARROW_GAP = 8;

export const STYLE_KEYS = ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "angle"] as const;

const style = (s: Style) => ({
  strokeColor: s.strokeColor ?? DEFAULT_STROKE,
  backgroundColor: s.backgroundColor ?? "transparent",
  fillStyle: s.fillStyle ?? "solid",
  strokeWidth: s.strokeWidth ?? 2,
  strokeStyle: s.strokeStyle ?? "solid",
  roughness: s.roughness ?? 1,
  opacity: s.opacity ?? 100,
  angle: s.angle ?? 0,
});

const pt = (p: Point): Pt => ({ x: p[0], y: p[1] });

/** Convert one skeleton; returns the element followed by its label, if it has one. */
function convert(skeleton: El): El[] {
  return convertToExcalidrawElements([skeleton as any], { regenerateIds: false }) as El[];
}

const labelOf = (spec: ElementSpec, fontSize: number) =>
  spec.label
    ? {
        label: {
          text: spec.label,
          fontSize: spec.fontSize ?? fontSize,
          fontFamily: FONT_FAMILY[spec.fontFamily ?? "hand"],
          strokeColor: spec.strokeColor ?? DEFAULT_STROKE,
        },
      }
    : {};

export function makeShape(spec: ElementSpec): El[] {
  const rounded = spec.rounded ?? true;
  const roundness = { rectangle: { type: 3 }, diamond: { type: 2 } }[spec.type as string] ?? null;
  return convert({
    type: spec.type,
    id: spec.id,
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
    ...style(spec),
    roundness: rounded ? roundness : null,
    ...labelOf(spec, LABEL_FONT_SIZE),
  });
}

export function makeText(spec: ElementSpec): El {
  return convert({
    type: "text",
    id: spec.id,
    x: spec.x,
    y: spec.y,
    text: spec.text,
    fontSize: spec.fontSize ?? 20,
    fontFamily: FONT_FAMILY[spec.fontFamily ?? "hand"],
    textAlign: spec.textAlign ?? "left",
    ...style(spec),
  })[0];
}

/** Position and relative points of a path, as Excalidraw stores a line. */
function pathGeometry(pts: Pt[]) {
  const p0 = pts[0];
  const rel = pts.map((p) => [p.x - p0.x, p.y - p0.y]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return { x: p0.x, y: p0.y, points: rel, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export const withPath = (el: El, pts: Pt[]): El => ({ ...el, ...pathGeometry(pts) });

export const absolutePoints = (el: El): Pt[] => (el.points as number[][]).map((p) => ({ x: el.x + p[0], y: el.y + p[1] }));

export function makeLine(spec: ElementSpec): El {
  const given = (spec.points ?? []).map(pt);
  const pts = spec.closed ? [...given, given[0]] : given;
  return convert({
    type: "line",
    id: spec.id,
    ...pathGeometry(pts),
    ...style(spec.closed ? spec : { ...spec, backgroundColor: "transparent" }),
    roundness: spec.rounded ? { type: 2 } : null,
  })[0];
}

export function makeFreedraw(spec: ElementSpec): El {
  const pts = smooth((spec.points ?? []).map(pt));
  const base = makeLine({ ...spec, points: [spec.points![0], spec.points![1]], closed: false, rounded: false });
  const { startArrowhead: _s, endArrowhead: _e, startBinding: _sb, endBinding: _eb, ...rest } = base;
  return withPath({ ...rest, type: "freedraw", roundness: null, pressures: [], simulatePressure: true, lastCommittedPoint: null }, pts);
}

/** An arrow end: an element to attach to, or a free point. */
export type End = El | Pt;
export const isPoint = (e: End): e is Pt => (e as El).type === undefined;

export const center = (el: El): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

/** Point on an element's outline in the direction of `toward`, pushed out by `gap`. */
function edgePoint(el: El, toward: Pt, gap: number): Pt {
  const c = center(el);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const a = Math.max(1, el.width / 2);
  const b = Math.max(1, el.height / 2);
  let k: number;
  if (el.type === "ellipse") k = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
  else if (el.type === "diamond") k = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  else k = Math.min(a / Math.max(Math.abs(dx), 1e-6), b / Math.max(Math.abs(dy), 1e-6));
  const g = gap / len;
  return { x: c.x + dx * (k + g), y: c.y + dy * (k + g) };
}

/** The path of an arrow. An attached end starts on the element's outline, facing the next point of the path. */
export function arrowPath(from: End, to: End, via: Pt[] = []): Pt[] {
  const aim = (e: End) => (isPoint(e) ? e : center(e));
  const start = isPoint(from) ? from : edgePoint(from, via[0] ?? aim(to), ARROW_GAP);
  const end = isPoint(to) ? to : edgePoint(to, via[via.length - 1] ?? aim(from), ARROW_GAP);
  return [start, ...via, end];
}

export function makeArrow(spec: ElementSpec, from: End, to: End): El[] {
  const path = arrowPath(from, to, (spec.via ?? []).map(pt));
  const els = convert({
    type: "arrow",
    id: spec.id,
    ...pathGeometry(path),
    ...style({ ...spec, backgroundColor: "transparent" }),
    startArrowhead: spec.startArrowhead ?? null,
    endArrowhead: spec.endArrowhead === undefined ? "arrow" : spec.endArrowhead,
    ...labelOf(spec, ARROW_LABEL_FONT_SIZE),
  });
  els[0] = {
    ...els[0],
    // convertToExcalidrawElements straightens the path; keep ours
    ...pathGeometry(path),
    roundness: spec.rounded ? { type: 2 } : null,
    startBinding: isPoint(from) ? null : { elementId: from.id, focus: 0, gap: ARROW_GAP },
    endBinding: isPoint(to) ? null : { elementId: to.id, focus: 0, gap: ARROW_GAP },
  };
  if (els[1]) els[1] = centerOn(els[1], pathMiddle(els[0]));
  return els;
}

export function makeImage(spec: ElementSpec, fileId: string): El {
  return convert({
    type: "image",
    id: spec.id,
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
    fileId,
    status: "saved",
    scale: [1, 1],
    opacity: spec.opacity ?? 100,
    angle: spec.angle ?? 0,
  })[0];
}

/**
 * A formula, which to Excalidraw is an image: `file` is its picture in the element's colour, with its size
 * in em. The image is cropped to the whole picture, which changes nothing until the crop is narrowed to
 * show the formula being written.
 */
export function makeMath(spec: ElementSpec, file: { fileId: string; width: number; height: number }): El {
  const fontSize = spec.fontSize ?? 20;
  const width = file.width * fontSize;
  const natural = { width: Math.round(file.width * MATH_PIXELS_PER_EM), height: Math.round(file.height * MATH_PIXELS_PER_EM) };
  return {
    ...makeImage({ ...spec, x: spec.x! - alignOffset(width, spec.textAlign), width, height: file.height * fontSize }, file.fileId),
    strokeColor: spec.strokeColor ?? DEFAULT_STROKE,
    crop: { x: 0, y: 0, ...natural, naturalWidth: natural.width, naturalHeight: natural.height },
  };
}

/** Halfway along a path, where an arrow's label sits. */
export function pathMiddle(el: El): Pt {
  const pts = absolutePoints(el);
  if (pts.length % 2) return pts[(pts.length - 1) / 2];
  const a = pts[pts.length / 2 - 1];
  const b = pts[pts.length / 2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export const centerOn = (el: El, c: Pt): El => ({ ...el, x: c.x - el.width / 2, y: c.y - el.height / 2 });

export const translate = <T extends End>(e: T, dx: number, dy: number): T => ({ ...e, x: e.x + dx, y: e.y + dy });

const isPath = (el: El) => el.type === "arrow" || el.type === "line" || el.type === "freedraw";

export function bbox(el: El): Rect {
  if (!isPath(el)) return { x: el.x, y: el.y, w: el.width, h: el.height };
  const pts = absolutePoints(el);
  const x = Math.min(...pts.map((p) => p.x));
  const y = Math.min(...pts.map((p) => p.y));
  return { x, y, w: Math.max(...pts.map((p) => p.x)) - x, h: Math.max(...pts.map((p) => p.y)) - y };
}

/** Fractional indices in creation order (a0..az, then b00..bzz), so Excalidraw keeps our stacking. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function fractionalIndex(i: number): string {
  if (i < 62) return `a${DIGITS[i]}`;
  const j = i - 62;
  return `b${DIGITS[Math.floor(j / 62) % 62]}${DIGITS[j % 62]}`;
}

/**
 * Excalidraw expects an element to list what is bound to it (its label, arrows attached to it). Elements
 * come and go during a replay, so the lists are derived from what is on the canvas at that moment.
 */
export function withBindings(els: El[]): El[] {
  const present = new Set(els.map((e) => e.id));
  const bound = new Map<string, { id: string; type: string }[]>();
  const add = (owner: string | undefined, id: string, type: string) => {
    if (!owner || !present.has(owner)) return;
    bound.set(owner, [...(bound.get(owner) ?? []), { id, type }]);
  };
  for (const e of els) {
    if (e.type === "text") add(e.containerId, e.id, "text");
    if (e.type === "arrow") {
      add(e.startBinding?.elementId, e.id, "arrow");
      add(e.endBinding?.elementId, e.id, "arrow");
    }
  }
  return els.map((e) => {
    const want = bound.get(e.id) ?? null;
    const orphan = e.type === "text" && e.containerId && !present.has(e.containerId);
    const same = JSON.stringify(e.boundElements ?? null) === JSON.stringify(want);
    if (same && !orphan) return e;
    return { ...e, boundElements: want, ...(orphan ? { containerId: null } : {}) };
  });
}
