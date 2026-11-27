/**
 * Functions of x for plotting, written the way they are on paper: `x^2 / 4`, `2 sin(x) + 1`,
 * `exp(-x^2)`. Parsed once into a function; nothing in it is run as code.
 */
import type { ElementSpec, Point } from "./types.ts";
import { reversePath, type Pt } from "../player/motion.ts";

const FUNCTIONS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  sigmoid: (v) => 1 / (1 + Math.exp(-v)),
  relu: (v) => Math.max(0, v),
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Fn = (x: number) => number;

/** Parses `source` into a function of x. Throws with a message that says what is wrong and where. */
export function parseFunction(source: string): Fn {
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z_][a-z_0-9]*|\*\*|[-+*/^(),]|\S/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const fail = (what: string): never => {
    throw new Error(`${what} in "${source}"${i < tokens.length ? ` at "${tokens.slice(i).join(" ")}"` : ""}`);
  };
  const take = (t: string) => (peek() === t ? (i++, true) : false);

  // sum := product (("+" | "-") product)*
  const sum = (): Fn => {
    let left = product();
    for (let op; (op = peek()) === "+" || op === "-"; ) {
      i++;
      const a = left;
      const b = product();
      left = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return left;
  };
  // product := unary (("*" | "/" | juxtaposition) unary)*, so that `2x` and `2 sin(x)` mean what they look like
  const product = (): Fn => {
    let left = unary();
    for (;;) {
      const op = peek();
      if (op === "*" || op === "/") i++;
      else if (op === undefined || !/^[\d.a-z_(]/i.test(op)) break;
      else if (/^[\d.]/.test(op) && /^[\d.]/.test(tokens[i - 1])) fail("An operator is missing between numbers");
      const a = left;
      const b = unary();
      left = op === "/" ? (x) => a(x) / b(x) : (x) => a(x) * b(x);
    }
    return left;
  };
  // unary := "-" unary | power ; so -x^2 is -(x^2)
  const unary = (): Fn => {
    if (take("-")) {
      const a = unary();
      return (x) => -a(x);
    }
    if (take("+")) return unary();
    return power();
  };
  // power := atom (("^" | "**") unary)?, right to left
  const power = (): Fn => {
    const base = atom();
    if (take("^") || take("**")) {
      const exp = unary();
      return (x) => base(x) ** exp(x);
    }
    return base;
  };
  const atom = (): Fn => {
    const t = peek();
    if (t === undefined) return fail("The formula ends too soon");
    if (take("(")) {
      const inner = sum();
      if (!take(")")) fail(`A ")" is missing`);
      return inner;
    }
    if (/^\d|^\./.test(t)) {
      i++;
      const n = Number(t);
      if (!Number.isFinite(n)) fail(`"${t}" is not a finite number`);
      return () => n;
    }
    if (/^[a-z_]/i.test(t)) {
      i++;
      const name = t.toLowerCase();
      if (name === "x") return (x) => x;
      if (Object.hasOwn(CONSTANTS, name)) return () => CONSTANTS[name];
      if (!Object.hasOwn(FUNCTIONS, name)) fail(`"${t}" is not x, a constant (pi, e) or a function (${Object.keys(FUNCTIONS).join(", ")})`);
      const f = FUNCTIONS[name];
      if (!take("(")) fail(`"${t}" needs its argument in brackets, like ${t}(x)`);
      const arg = sum();
      if (!take(")")) fail(`A ")" is missing`);
      return (x) => f(arg(x));
    }
    return fail(`Unexpected "${t}"`);
  };

  const fn = sum();
  if (i < tokens.length) fail("Unexpected text");
  return fn;
}

/**
 * The points of a plot: `fn` sampled across `domain` and mapped onto the box, y up. Points where the
 * function has no value, or leaves `range`, are left out.
 */
export function plotSegments(fn: Fn, box: Box, domain: [number, number], range?: [number, number], samples = 96): [number, number][][] {
  const plot = plotOf(fn, box, domain, range, samples);
  return samplesInRange(plot, range).map((part) => part.map(([x, y]) => plot.toCanvas(x, y)));
}

function samplesInRange(plot: ReturnType<typeof plotOf>, range?: Point): Point[][] {
  const span = plot.hi - plot.lo || 1;
  // Refine actual range crossings. A straight chord between sampled values can cross the window
  // at a pole even when the function itself never does.
  function crossing(k: number, y: number): [number, number] | null {
    const a = plot.ys[k - 1], b = plot.ys[k];
    if (!(a < y && y < b || b < y && y < a) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    let left = plot.xs[k - 1], right = plot.xs[k];
    const tolerance = Math.max(Math.abs(y), span) * 1e-9;
    for (let i = 0; i < 52; i++) {
      const mid = left + (right - left) / 2;
      const value = plot.fn(mid);
      if (!Number.isFinite(value)) return null;
      if (Math.abs(value - y) <= tolerance) return [mid, y];
      if ((value < y) === (a < b)) left = mid;
      else right = mid;
    }
    return null;
  }
  const points: [number, number][] = [];
  for (const [k, x] of plot.xs.entries()) {
    if (range && k > 0) {
      const edges = range.map((y) => crossing(k, y)).filter((p): p is [number, number] => p !== null);
      points.push(...edges.sort((a, b) => a[0] - b[0]));
    }
    points.push([x, plot.ys[k]]);
  }
  const segments: [number, number][][] = [];
  let segment: [number, number][] = [];
  for (const [x, y] of points) {
    if (!Number.isFinite(y) || y < plot.lo - span * 1e-9 || y > plot.hi + span * 1e-9) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    } else segment.push([x, y]);
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
}

export function plotPoints(fn: Fn, box: Box, domain: [number, number], range?: [number, number], samples = 96): [number, number][] {
  return plotSegments(fn, box, domain, range, samples).flat();
}

type Box = { x: number; y: number; width: number; height: number };

/** A plot's samples, the y values its box spans, and where a point of it (in its own units) is on the canvas. */
export function plotOf(fn: Fn, box: Box, domain: [number, number], range?: [number, number], samples = 96) {
  const xs = Array.from({ length: samples + 1 }, (_, k) => domain[0] + ((domain[1] - domain[0]) * k) / samples);
  const ys = xs.map(fn);
  const finite = ys.filter(Number.isFinite);
  const [lo, hi] = range ?? [Math.min(...finite), Math.max(...finite)];
  const span = hi - lo || 1;
  const toCanvas = (x: number, y: number): [number, number] => [box.x + ((x - domain[0]) / (domain[1] - domain[0])) * box.width, box.y + box.height - ((y - lo) / span) * box.height];
  return { xs, ys, lo, hi, toCanvas, fn, box };
}

/** A point of a plot by its x: `["loss", -2.4]` is where the curve named "loss" is at x = -2.4. */
export type PlotRef = [string, number];
export const isPlotRef = (v: unknown): v is PlotRef => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" && Number.isFinite(v[1]);

/**
 * The plots of a script, as they are added, so a point given as `["loss", x]` can be found on the canvas.
 * `path` also gives the curve between two such points on one plot, for something to travel along it.
 */
export class Plots {
  private plots = new Map<string, ReturnType<typeof plotOf> & { segments: Point[][]; angle: number; center: Point }>();

  /** Register the samples in plot units and return the unrotated canvas strokes the player draws. */
  add(spec: ElementSpec): Point[][] {
    const plot = plotOf(parseFunction(spec.fn!), { x: spec.x!, y: spec.y!, width: spec.width!, height: spec.height! }, spec.domain!, spec.range);
    const segments = samplesInRange(plot, spec.range);
    const strokes = segments.map((part) => part.map(([x, y]) => plot.toCanvas(x, y)));
    const xs = strokes.flat().map(([x]) => x), ys = strokes.flat().map(([, y]) => y);
    const center: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    if (strokes.length) this.plots.set(spec.id, { ...plot, segments, angle: spec.angle ?? 0, center });
    return strokes;
  }

  has = (id: string) => this.plots.has(id);

  move(id: string, dx: number, dy: number, angle?: number) {
    const plot = this.plots.get(id);
    if (plot) {
      plot.box.x += dx;
      plot.box.y += dy;
      plot.center[0] += dx;
      plot.center[1] += dy;
      if (angle !== undefined) plot.angle = angle;
    }
  }

  remove(id: string) {
    this.plots.delete(id);
  }

  /** The canvas point of a plot point, or null when there is no such plot or it has no value there. */
  point([id, x]: PlotRef): [number, number] | null {
    const plot = this.plots.get(id);
    if (!plot) return null;
    const y = plot.fn(x);
    if (!Number.isFinite(y)) return null;
    const [px, py] = plot.toCanvas(x, y);
    const [cx, cy] = plot.center;
    const cos = Math.cos(plot.angle), sin = Math.sin(plot.angle);
    const p: Point = plot.angle ? [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos] : [px, py];
    return p.every(Number.isFinite) ? p : null;
  }

  /** The curve from one point of a plot to another, sampled finely enough to follow it. */
  private curve(id: string, from: number, to: number): Pt[] {
    if (from > to) return reversePath(this.curve(id, to, from));
    const plot = this.plots.get(id)!;
    const route: Pt[] = [];
    let previous = NaN;
    const append = (x: number, move = false) => {
      const p = this.point([id, x]);
      if (p) route.push({ x: p[0], y: p[1], ...(move ? { move: true } : {}) });
      previous = x;
    };
    append(from);
    for (const stretch of plot.segments) {
      const lo = Math.max(from, stretch[0][0]), hi = Math.min(to, stretch.at(-1)![0]);
      if (hi <= lo) continue;
      if (lo !== previous) append(lo, true);
      for (const [x] of stretch) if (lo < x && x < hi) append(x);
      append(hi);
    }
    if (to !== previous || from === to) append(to, to !== previous);
    return route;
  }

  /** Resolve an explicit route once for the checker and player, retaining breaks in its curves. */
  path(refs: (Point | PlotRef)[]): Pt[] {
    return refs.flatMap((p, i) => {
      const previous = refs[i - 1];
      if (isPlotRef(p) && isPlotRef(previous) && previous[0] === p[0]) return this.curve(p[0], previous[1], p[1]).slice(1);
      const [x, y] = isPlotRef(p) ? this.point(p)! : p;
      return [{ x, y }];
    });
  }
}
