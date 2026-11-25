/**
 * Functions of x for plotting, written the way they are on paper: `x^2 / 4`, `2 sin(x) + 1`,
 * `exp(-x^2)`. Parsed once into a function; nothing in it is run as code.
 */

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
  const tokens = source.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z_][a-z_0-9]*|\*\*|[-+*/^(),]|\S/gi) ?? [];
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
    take("+");
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
      return () => n;
    }
    if (/^[a-z_]/i.test(t)) {
      i++;
      const name = t.toLowerCase();
      if (name === "x") return (x) => x;
      if (name in CONSTANTS) return () => CONSTANTS[name];
      const f = FUNCTIONS[name];
      if (!f) fail(`"${t}" is not x, a constant (pi, e) or a function (${Object.keys(FUNCTIONS).join(", ")})`);
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
export function plotPoints(fn: Fn, box: Box, domain: [number, number], range?: [number, number], samples = 96): [number, number][] {
  const plot = plotOf(fn, box, domain, range, samples);
  const span = plot.hi - plot.lo || 1;
  return plot.xs.flatMap((x, k) => {
    const y = plot.ys[k];
    return !Number.isFinite(y) || y < plot.lo - span * 1e-9 || y > plot.hi + span * 1e-9 ? [] : [plot.toCanvas(x, y)];
  });
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
  return { xs, ys, lo, hi, toCanvas, fn };
}

/** A point of a plot by its x: `["loss", -2.4]` is where the curve named "loss" is at x = -2.4. */
export type PlotRef = [string, number];
export const isPlotRef = (v: unknown): v is PlotRef => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" && Number.isFinite(v[1]);

/**
 * The plots of a script, as they are added, so a point given as `["loss", x]` can be found on the canvas.
 * `path` also gives the curve between two such points on one plot, for something to travel along it.
 */
export class Plots {
  private plots = new Map<string, ReturnType<typeof plotOf>>();

  /** Notes a line with `fn`; returns false when its function cannot be read. */
  add(spec: { id: string; fn?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; domain?: unknown; range?: unknown }): boolean {
    try {
      this.plots.set(spec.id, plotOf(parseFunction(String(spec.fn)), { x: Number(spec.x), y: Number(spec.y), width: Number(spec.width), height: Number(spec.height) }, spec.domain as [number, number], spec.range as [number, number] | undefined));
      return true;
    } catch {
      return false;
    }
  }

  has = (id: string) => this.plots.has(id);

  /** The canvas point of a plot point, or null when there is no such plot or it has no value there. */
  point([id, x]: PlotRef): [number, number] | null {
    const plot = this.plots.get(id);
    if (!plot) return null;
    const y = plot.fn(x);
    return Number.isFinite(y) ? plot.toCanvas(x, y) : null;
  }

  /** The curve from one point of a plot to another, sampled finely enough to follow it. */
  path(a: PlotRef, b: PlotRef, samples = 32): [number, number][] {
    if (a[0] !== b[0]) return [this.point(a), this.point(b)].filter((p): p is [number, number] => !!p);
    return Array.from({ length: samples + 1 }, (_, k) => this.point([a[0], a[1] + ((b[1] - a[1]) * k) / samples])).filter((p): p is [number, number] => !!p);
  }
}
