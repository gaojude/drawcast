import type { Pt } from "../player/motion.ts";

/** The circle's bounding box, plus the clockwise sector in percentages from twelve o'clock. */
export interface Slice {
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  share: number;
  angle?: number;
}

const turn = 2 * Math.PI;
const percent = (n: number) => ((n % 100) + 100) % 100;
const startOf = (s: Slice) => percent(s.start + ((s.angle ?? 0) % turn) * 100 / turn);

function arcPoint(s: Slice, at: number, fraction = 1): Pt {
  const theta = at * turn / 100;
  return {
    x: s.x + s.width / 2 * (1 + fraction * Math.sin(theta)),
    y: s.y + s.height / 2 * (1 - fraction * Math.cos(theta)),
  };
}

export function sliceLabelCenter(s: Slice): Pt {
  return arcPoint(s, startOf(s) + s.share / 2, s.share === 100 ? 0 : 0.6);
}

/** A closed polygon with exact quadrant extrema. The whole disk has no radial edge. */
export function sliceOutline(s: Slice): Pt[] {
  const start = startOf(s), end = start + s.share;
  const points = [arcPoint(s, start)];
  // Subdivide each quadrant into small chords, retaining the exact start and end bearings.
  const stride = 100 / 96;
  for (let i = Math.floor(start / stride) + 1; i * stride < end; i++) points.push(arcPoint(s, i * stride));
  if (s.share < 100) {
    points.push(arcPoint(s, end));
    points.unshift({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
  }
  points.push(points[0]);
  return points;
}

export function sliceBounds(s: Slice) {
  const points = sliceOutline(s);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Concentric wedges can share a radial edge even when their bounding boxes cross. */
export function separateSlices(a: Slice, b: Slice): boolean {
  if (a.x + a.width / 2 !== b.x + b.width / 2 || a.y + a.height / 2 !== b.y + b.height / 2) return false;
  const delta = percent(startOf(b) - startOf(a));
  return delta >= a.share - 1e-10 && 100 - delta >= b.share - 1e-10;
}
