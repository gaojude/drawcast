/** Easing and path helpers. */

export interface Pt {
  x: number;
  y: number;
  /** Starts a new visible stretch after a gap in a plot. */
  move?: boolean;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Rotate the route before measuring travel along it, preserving any gaps between strokes. */
export function rotatePath(points: Pt[], angle: number, center?: Pt): Pt[] {
  if (!angle || !points.length) return points;
  if (!center) {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const p of points) {
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
    center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  const { x: cx, y: cy } = center, cos = Math.cos(angle), sin = Math.sin(angle);
  return points.map((p) => ({
    ...p, x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
  }));
}

/** Minimum-jerk profile: the bell-shaped velocity curve of a reaching hand. */
export const minJerk = (u: number) => {
  u = clamp(u, 0, 1);
  return u * u * u * (10 - 15 * u + 6 * u * u);
};

/** Minimum jerk with a small overshoot, like a hand that drags a little past the corner and settles. */
export const dragEase = (u: number, overshoot = 0.06) => {
  u = clamp(u, 0, 1);
  return minJerk(u) + overshoot * u * u * Math.sin(Math.PI * u * u);
};

export const polylineLength = (pts: Pt[]) => {
  let total = 0;
  for (let i = 1; i < pts.length; i++) if (!pts[i].move) total += dist(pts[i - 1], pts[i]);
  return total;
};

/** The polyline up to fraction `u` of its length: the points passed, then the point reached. */
export function partialPolyline(pts: Pt[], u: number): Pt[] {
  if (pts.length < 2) return pts;
  let left = clamp(u, 0, 1) * polylineLength(pts);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].move) {
      out.push(pts[i]);
      continue;
    }
    const d = dist(pts[i - 1], pts[i]);
    if (left >= d && i < pts.length - 1) {
      out.push(pts[i]);
      left -= d;
      continue;
    }
    const k = d === 0 ? 1 : clamp(left / d, 0, 1);
    out.push({ x: lerp(pts[i - 1].x, pts[i].x, k), y: lerp(pts[i - 1].y, pts[i].y, k) });
    break;
  }
  return out;
}

export function reversePath(pts: Pt[]): Pt[] {
  return pts.map(({ x, y }, i) => (pts[i + 1]?.move ? { x, y, move: true } : { x, y })).reverse();
}

/** The part of a polyline from fraction `a` to fraction `b` of its length. */
export function subPath(pts: Pt[], a: number, b: number): Pt[] {
  const upTo = partialPolyline(pts, b);
  const skip = clamp(a, 0, b) * polylineLength(pts);
  const total = polylineLength(upTo);
  if (skip <= 0 || total <= 0) return upTo;
  // the same path backwards, cut short, and turned round again
  return reversePath(partialPolyline(reversePath(upTo), 1 - skip / total));
}

/** Distant off-canvas control points should not allocate millions of invisible subdivisions. */
export const curveSamples = (length: number, step: number) => Math.min(4096, Math.ceil(length / step));

/** A smooth curve through the points (Catmull-Rom), sampled about every `step` units. */
export function smooth(points: Pt[], step = 8): Pt[] {
  if (points.length < 3) return points;
  const out: Pt[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const n = Math.max(2, curveSamples(dist(p1, p2), step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({ x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  return out;
}

const HEX = /^#([0-9a-f]{6})$/i;

/** Blend two `#rrggbb` colours; anything else switches halfway. */
export function lerpColor(a: string, b: string, u: number): string {
  const ma = HEX.exec(a);
  const mb = HEX.exec(b);
  if (!ma || !mb) return u < 0.5 ? a : b;
  const ca = parseInt(ma[1], 16);
  const cb = parseInt(mb[1], 16);
  const ch = (shift: number) => Math.round(lerp((ca >> shift) & 255, (cb >> shift) & 255, u));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}
