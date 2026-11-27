/** Building Excalidraw elements from the specs in a script. */
import { convertToExcalidrawElements, getCommonBounds } from "@excalidraw/excalidraw";
import { type ElementSpec, MATH_PIXELS_PER_EM, type Point, type Style, alignOffset } from "../shared/types.ts";
import { type Pt, rotatePath, smooth } from "./motion.ts";
import { ARROW_GAP, type ArrowEnd, arrowCourse as connection, arrowLabelCenter } from "../shared/arrows.ts";
import { parseFunction, plotSegments } from "../shared/expr.ts";

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
  let left = 0, right = 0, top = 0, bottom = 0;
  const rel = pts.map((p) => [p.x - p0.x, p.y - p0.y]);
  for (const [x, y] of rel) {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { x: p0.x, y: p0.y, points: rel, width: right - left, height: bottom - top };
}

export const withPath = (el: El, pts: Pt[]): El => ({
  ...el, ...pathGeometry(pts),
  ...(el.breaks ? { breaks: pts.flatMap((p, i) => p.move ? [i] : []) } : {}),
});

export const absolutePoints = (el: El): Pt[] => {
  const breaks = el.breaks && new Set<number>(el.breaks);
  return (el.points as number[][]).map((p, i) => ({ x: el.x + p[0], y: el.y + p[1], ...(breaks?.has(i) ? { move: true } : {}) }));
};

/** The path as it appears on the board, after Excalidraw rotates it around its unrotated bounds. */
export function scenePoints(el: El): Pt[] {
  const pts = absolutePoints(el);
  if (!el.angle) return pts;
  const box = bbox({ ...el, angle: 0 });
  return rotatePath(pts, el.angle, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
}

export function makeLine(spec: ElementSpec): El {
  const given = (spec.points ?? []).map(pt);
  const pts = spec.closed && !spec.breaks?.length ? [...given, given[0]] : given;
  const [line] = convert({
    type: "line",
    id: spec.id,
    ...pathGeometry(pts),
    ...style(spec.closed ? spec : { ...spec, backgroundColor: "transparent" }),
    roundness: spec.rounded ? { type: 2 } : null,
  });
  return spec.breaks?.length ? { ...line, breaks: spec.breaks, closeSegments: spec.closed } : line;
}

/** Sample a parameterized line in its original coordinates, then apply its independently animated translation. */
export function parameterizedLine(spec: ElementSpec, original: El) {
  let sampled: number | undefined;
  const fn = parseFunction(spec.fn!, () => sampled!);
  const box = { x: spec.x!, y: spec.y!, width: spec.width!, height: spec.height! };
  let geometry: ReturnType<typeof pathGeometry> & { breaks: number[] } | undefined;
  return (el: El): El | undefined => {
    if (el.plotParameter === undefined) return el; // includes the original growing stroke
    if (sampled !== el.plotParameter) {
      sampled = el.plotParameter;
      const segments = plotSegments(fn, box, spec.domain!, spec.range);
      if (spec.closed && segments.length === 1) segments[0].push(segments[0][0]);
      const points = segments.flatMap((part, i) => part.map(([x, y], j) => ({ x, y, move: i > 0 && j === 0 })));
      geometry = points.length ? { ...pathGeometry(points), breaks: points.flatMap((p, i) => p.move ? [i] : []) } : undefined;
    }
    return geometry ? { ...el, ...geometry, x: geometry.x + (el.x - original.x), y: geometry.y + (el.y - original.y), closeSegments: spec.closed } : undefined;
  };
}

/** Excalidraw lines are continuous. Each visible stretch of a clipped plot needs its own stroke. */
export function visibleSegments(elements: El[]): El[] {
  if (!elements.some((el) => el.breaks?.length)) return elements;
  const ids = new Set(elements.map((el) => el.id));
  const expanded = elements.flatMap((el) => {
    if (!el.breaks?.length) return [el];
    const pts = scenePoints(el);
    const starts: number[] = [0, ...el.breaks];
    return starts.flatMap((start, i) => {
      const part = pts.slice(start, starts[i + 1]);
      if (part.length < 2) return [];
      if (el.closeSegments) part.push(part[0]);
      let id = el.id;
      if (i) {
        id = `${id}/segment-${i}`;
        while (ids.has(id)) id += "_";
        ids.add(id);
      }
      return [{ ...el, ...pathGeometry(part), id, angle: 0, breaks: undefined }];
    });
  });
  return expanded.map((el, i) => ({ ...el, index: fractionalIndex(i) }));
}

export function makeFreedraw(spec: ElementSpec): El {
  const given = (spec.points ?? []).map(pt);
  const starts = [0, ...(spec.breaks ?? [])];
  const pts = starts.flatMap((start, i) => {
    const part = smooth(given.slice(start, starts[i + 1]));
    if (i && part.length) part[0] = { ...part[0], move: true };
    return part;
  });
  const base = makeLine({ ...spec, points: [spec.points![0], spec.points![1]], closed: false, rounded: false });
  const { startArrowhead: _s, endArrowhead: _e, startBinding: _sb, endBinding: _eb, ...rest } = base;
  return withPath({ ...rest, type: "freedraw", roundness: null, pressures: [], simulatePressure: true, lastCommittedPoint: null }, pts);
}

/** An arrow end: an element to attach to, or a free point. */
export type End = El | Pt;
export const isPoint = (e: End): e is Pt => (e as El).type === undefined;

export const center = (el: El): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

export function arrowCourse(from: End, to: End, via: Pt[] = [], rounded?: boolean): Pt[] {
  return connection(from as ArrowEnd, to as ArrowEnd, via, rounded);
}

export function makeArrow(spec: ElementSpec, from: End, to: End): El[] {
  const path = arrowCourse(from, to, (spec.via ?? []).map(pt), spec.rounded);
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
    // a curve through `via` is already smooth; without `via` there is nothing to round
    roundness: null,
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
  return arrowLabelCenter(scenePoints(el));
}

export const centerOn = (el: El, c: Pt): El => ({ ...el, x: c.x - el.width / 2, y: c.y - el.height / 2 });

export const translate = <T extends End>(e: T, dx: number, dy: number): T => ({ ...e, x: e.x + dx, y: e.y + dy });

export function bbox(el: El): Rect {
  const [x, y, right, bottom] = getCommonBounds([el as any]);
  return { x, y, w: right - x, h: bottom - y };
}

/** Fractional indices in creation order (a0..az, then b00..bzz), so Excalidraw keeps our stacking. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function fractionalIndex(i: number): string {
  let width = 1;
  while (i >= DIGITS.length ** width) {
    i -= DIGITS.length ** width;
    width++;
  }
  let digits = "";
  for (let j = 0; j < width; j++) {
    digits = DIGITS[i % DIGITS.length] + digits;
    i = Math.floor(i / DIGITS.length);
  }
  return String.fromCharCode(96 + width) + digits;
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
      if (e.endBinding?.elementId !== e.startBinding?.elementId) add(e.endBinding?.elementId, e.id, "arrow");
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
