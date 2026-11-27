import { type Pt, curveSamples, smooth } from "../player/motion.ts";

export interface ArrowShape {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
}
export type ArrowEnd = Pt | ArrowShape;

/** Excalidraw centers a label on the middle vertex, or halfway between the middle pair. */
export function arrowLabelCenter(points: Pt[]): Pt {
  const i = Math.floor(points.length / 2);
  if (points.length % 2) return points[i];
  return { x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 };
}
const isPoint = (end: ArrowEnd): end is Pt => !("type" in end);
const center = (el: ArrowShape): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

/** Gap between an attached arrow and the outline it points at. */
export const ARROW_GAP = 8;

/** Point on an element's outline in the direction of `toward`, pushed out by `gap`. */
function edgePoint(el: ArrowShape, toward: Pt, gap: number, fallback: number): Pt {
  const c = center(el);
  let dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) dx = fallback;
  const len = Math.hypot(dx, dy);
  const cos = Math.cos(el.angle ?? 0), sin = Math.sin(el.angle ?? 0);
  const localX = Math.abs(cos * dx + sin * dy);
  const localY = Math.abs(-sin * dx + cos * dy);
  const a = Math.max(1, el.width / 2);
  const b = Math.max(1, el.height / 2);
  let k: number;
  if (el.type === "ellipse") k = 1 / Math.hypot(localX / a, localY / b);
  else if (el.type === "diamond") k = 1 / (localX / a + localY / b);
  else k = 1 / Math.max(localX / a, localY / b);
  const g = gap / len;
  return { x: c.x + dx * (k + g), y: c.y + dy * (k + g) };
}

/** The path of an arrow. An attached end starts on the element's outline, facing the next point of the path. */
function arrowPath(from: ArrowEnd, to: ArrowEnd, via: Pt[] = []): Pt[] {
  const aim = (e: ArrowEnd) => (isPoint(e) ? e : center(e));
  const start = isPoint(from) ? from : edgePoint(from, via[0] ?? aim(to), ARROW_GAP, 1);
  const end = isPoint(to) ? to : edgePoint(to, via[via.length - 1] ?? aim(from), ARROW_GAP, -1);
  return [start, ...via, end];
}

/**
 * An arrow's course: its path, and when it is `rounded` with `via` points, a smooth curve through them.
 * Excalidraw's own rounding pulls a curve through few points into a hook at each one, so the curve is
 * drawn here, as many short straight pieces.
 */
export function arrowCourse(from: ArrowEnd, to: ArrowEnd, via: Pt[], rounded?: boolean): Pt[] {
  const path = arrowPath(from, to, via);
  if (!rounded || !via.length) return path;
  let pts: Pt[];
  if (path.length === 3) {
    // one point to pass through: a single even arc, the curve whose middle is that point
    const [a, v, b] = path;
    const c = { x: 2 * v.x - (a.x + b.x) / 2, y: 2 * v.y - (a.y + b.y) / 2 };
    const n = Math.max(8, curveSamples(Math.hypot(v.x - a.x, v.y - a.y) + Math.hypot(b.x - v.x, b.y - v.y), 12));
    pts = Array.from({ length: n + 1 }, (_, k) => {
      const t = k / n;
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
    });
  } else pts = smooth(path, 12);
  // Excalidraw sizes an arrowhead by the piece of line it sits on: keep the end pieces long enough to carry one
  const [first, last] = [pts[0], pts[pts.length - 1]];
  const far = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) >= HEAD_ROOM;
  return pts.filter((p, i) => i === 0 || i === pts.length - 1 || (far(p, first) && far(p, last)));
}

/** How long the end pieces of a curved arrow are kept, so its heads are drawn full size. */
const HEAD_ROOM = 30;
