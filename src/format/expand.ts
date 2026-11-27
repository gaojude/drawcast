/**
 * Shorthands a script may use, written out as the properties they stand for, so that the player only
 * ever sees the long form. Runs after `check`, on a script that passed it.
 *
 * - `color: "blue"` is a stroke and a fill from the palette (the fill only on what can be filled).
 * - a `line` with `fn` is the function plotted: its `points`.
 * - a point given as `["loss", -2.4]` is where the plot "loss" is at x = -2.4; two such points of one
 *   plot in a row are the stretch of curve between them. `on` puts a shape's middle on such a point.
 */
import { type PlotRef, Plots, isPlotRef } from "../shared/expr.ts";
import { type AxisRef, isAxisRef } from "../shared/axes.ts";
import { type Action, type ElementSpec, PALETTE, type Point, type Script, type ShapeCenter, type Style, type UpdateSpec, isShapeCenter } from "../shared/types.ts";

const FILLED = new Set(["rectangle", "ellipse", "diamond", "slice"]);

function colored<T extends Style>(spec: T, fillable: boolean): T {
  if (!spec.color) return spec;
  const [stroke, fill] = PALETTE[spec.color];
  const { color: _, ...rest } = spec;
  return { ...rest, strokeColor: spec.strokeColor ?? stroke, ...(fillable ? { backgroundColor: spec.backgroundColor ?? fill } : {}) } as T;
}

export function expand(script: Script, resolvedPoints?: WeakMap<AxisRef | ShapeCenter, Point>): Script {
  const fillable = new Set<string>();
  const plots = new Plots();
  // Positions captured by the checker include moves and resizes preceding this action.
  const resolved = (p: AxisRef | ShapeCenter): Point => {
    const value = resolvedPoints?.get(p);
    if (!value) throw new Error(`Unresolved point ${JSON.stringify(p)}.`);
    return value;
  };
  const point = (p: Point | PlotRef | AxisRef | ShapeCenter): Point => isAxisRef(p) || isShapeCenter(p) ? resolved(p) : isPlotRef(p) ? plots.point(p)! : p;
  /** A list of points, where two points of one plot in a row become the curve between them. */
  const points = (refs: (Point | PlotRef | AxisRef | ShapeCenter)[]) => {
    const path = plots.path(refs.map((p) => isAxisRef(p) || isShapeCenter(p) ? resolved(p) : p));
    const breaks = path.flatMap((p, i) => p.move ? [i] : []);
    return { points: path.map(({ x, y }): Point => [x, y]), ...(breaks.length ? { breaks } : {}) };
  };
  const ref = <T>(r: T): T => (isPlotRef(r) || isAxisRef(r) || isShapeCenter(r) ? (point(r) as T) : r);

  const element = (spec: ElementSpec): ElementSpec => {
    let out = colored(spec, FILLED.has(spec.type) || (spec.type === "line" && !!spec.closed));
    if (out.type === "line" && out.fn) {
      const segments = plots.add(out);
      const { fn, domain, range, x, y, width, height, ...rest } = out;
      // a curve of many points drawn rough doubles back on itself
      const breaks: number[] = [];
      let length = 0;
      for (const segment of segments) {
        if (length) breaks.push(length);
        length += segment.length;
      }
      // A parameterized plot keeps its formula so the player can sample intermediate values.
      out = { ...(rest.p === undefined ? {} : { fn, domain, range, x, y, width, height }), ...rest, points: segments.flat(), ...(breaks.length ? { breaks } : {}), roughness: rest.roughness ?? 0 };
    } else if (out.points) out = { ...out, ...points(out.points) };
    if (out.type === "arrow") out = { ...out, from: ref(out.from), to: ref(out.to), ...(out.via ? { via: points(out.via).points } : {}) };
    const { on, ...placed } = out;
    if (on) {
      const [cx, cy] = point(on);
      return { ...placed, x: cx - (placed.width ?? 0) / 2, y: cy - (placed.height ?? 0) / 2 };
    }
    return placed;
  };

  const expandUpdate = (update: UpdateSpec): UpdateSpec => {
    const ids = [update.id].flat();
    if (update.color) {
      const allFilled = ids.every((id) => fillable.has(id));
      const mixed = !allFilled && ids.some((id) => fillable.has(id));
      // Mixed targets move together. The player assigns the palette fill to just the shapes.
      update = mixed ? { ...update, strokeColor: update.strokeColor ?? PALETTE[update.color][0] } : colored(update, allFilled);
    }
    if (Array.isArray(update.along)) {
      const { points: along, breaks } = points(update.along);
      update = { ...update, along, ...(breaks ? { breaks } : {}) };
    }
    for (const id of ids) {
      if (update.p !== undefined) plots.setParameter(id, update.p);
      plots.move(id, update.dx ?? 0, update.dy ?? 0, update.angle);
    }
    return update;
  };

  const action = (a: Action): Action => {
    if (a.add) {
      const add = Array.isArray(a.add) ? a.add.map(element) : element(a.add);
      for (const el of [a.add].flat()) if (FILLED.has(el.type) || (el.type === "line" && el.closed)) fillable.add(el.id);
      return { ...a, add };
    }
    if (a.update) return { ...a, update: Array.isArray(a.update) ? a.update.map(expandUpdate) : expandUpdate(a.update) };
    if (a.remove) for (const id of [a.remove].flat()) plots.remove(id);
    if (a.point !== undefined) return { ...a, point: ref(a.point) };
    return a;
  };

  return { ...script, steps: script.steps.map((step) => ({ ...step, do: step.do?.map(action) })) };
}
