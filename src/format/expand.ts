/**
 * Shorthands a script may use, written out as the properties they stand for, so that the player only
 * ever sees the long form. Runs after `check`, on a script that passed it.
 *
 * - `color: "blue"` is a stroke and a fill from the palette (the fill only on what can be filled).
 * - a `line` with `fn` is the function plotted: its `points`.
 * - a point given as `["loss", -2.4]` is where the plot "loss" is at x = -2.4; two such points of one
 *   plot in a row are the stretch of curve between them. `on` puts a shape's middle on such a point.
 */
import { type PlotRef, Plots, isPlotRef, parseFunction, plotPoints } from "../shared/expr.ts";
import { type Action, type ElementSpec, PALETTE, type Point, type Script, type Style, type UpdateSpec } from "../shared/types.ts";

const FILLED = new Set(["rectangle", "ellipse", "diamond"]);

function colored<T extends Style>(spec: T, fillable: boolean): T {
  if (!spec.color) return spec;
  const [stroke, fill] = PALETTE[spec.color];
  const { color: _, ...rest } = spec;
  return { ...rest, strokeColor: spec.strokeColor ?? stroke, ...(fillable ? { backgroundColor: spec.backgroundColor ?? fill } : {}) } as T;
}

export function expand(script: Script): Script {
  const types = new Map<string, string>();
  const plots = new Plots();
  const point = (p: Point | PlotRef): Point => (isPlotRef(p) ? (plots.point(p) ?? [0, 0]) : p);
  /** A list of points, where two points of one plot in a row become the curve between them. */
  const points = (list: (Point | PlotRef)[]): Point[] =>
    list.flatMap((p, i) => {
      const prev = list[i - 1];
      if (isPlotRef(p) && isPlotRef(prev) && prev[0] === p[0]) return plots.path(prev, p).slice(1);
      return [point(p)];
    });
  const ref = <T>(r: T): T => (isPlotRef(r) ? (point(r) as T) : r);

  const element = (spec: ElementSpec & { on?: PlotRef }): ElementSpec => {
    let out = colored(spec, FILLED.has(spec.type) || (spec.type === "line" && !!spec.closed));
    if (out.type === "line" && out.fn) {
      plots.add(out);
      const { fn, domain, range, x, y, width, height, ...rest } = out;
      // a curve of many points drawn rough doubles back on itself
      out = { ...rest, points: plotPoints(parseFunction(fn), { x: x!, y: y!, width: width!, height: height! }, domain!, range), roughness: rest.roughness ?? 0 };
    }
    if (out.points) out = { ...out, points: points(out.points as (Point | PlotRef)[]) };
    if (out.type === "arrow") out = { ...out, from: ref(out.from), to: ref(out.to), ...(out.via ? { via: out.via.map(point) } : {}) };
    const { on, ...placed } = out as ElementSpec & { on?: PlotRef };
    if (on) {
      const [cx, cy] = point(on);
      return { ...placed, x: cx - (placed.width ?? 0) / 2, y: cy - (placed.height ?? 0) / 2 };
    }
    return placed;
  };

  const action = (a: Action): Action => {
    if (a.add) {
      const add = Array.isArray(a.add) ? a.add.map(element) : element(a.add);
      for (const el of [a.add].flat()) types.set(el.id, el.type);
      return { ...a, add };
    }
    if (a.update) {
      let update: UpdateSpec = a.update;
      if (update.color) update = colored(update, [update.id].flat().some((id) => FILLED.has(types.get(id) ?? "")));
      if (Array.isArray(update.along)) update = { ...update, along: points(update.along as (Point | PlotRef)[]) };
      return { ...a, update };
    }
    if (a.point !== undefined) return { ...a, point: ref(a.point) };
    return a;
  };

  return { ...script, steps: script.steps.map((step) => ({ ...step, do: step.do?.map(action) })) };
}
