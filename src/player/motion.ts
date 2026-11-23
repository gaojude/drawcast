/** Easing and path helpers. */

export interface Pt {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

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
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
};

/** The polyline up to fraction `u` of its length: the points passed, then the point reached. */
export function partialPolyline(pts: Pt[], u: number): Pt[] {
  if (pts.length < 2) return pts;
  let left = clamp(u, 0, 1) * polylineLength(pts);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
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

/** A smooth curve through the points (Catmull-Rom), sampled about every `step` units. */
export function smooth(points: Pt[], step = 8): Pt[] {
  if (points.length < 3) return points;
  const out: Pt[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(dist(p1, p2) / step));
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
