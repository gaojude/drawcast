/**
 * Checks a script before anything is spoken or drawn.
 *
 * Errors are things the renderer cannot act on (an arrow to an element that does not exist, a phrase the
 * narration never says). Warnings are things it can draw but a viewer would probably not want (two boxes
 * half on top of each other, a label too long for its shape). Whoever wrote the script usually cannot see
 * the picture, so every message says where the problem is and what would fix it.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { findPhrase, tokens, widthEm } from "../shared/text.ts";
import { Plots, isPlotRef, type PlotRef } from "../shared/expr.ts";
import { partialPolyline, type Pt } from "../player/motion.ts";
import { arrowCourse, arrowLabelCenter, type ArrowEnd } from "../shared/arrows.ts";
import { DEFAULT_CANVAS, type ElementSpec, type Formula, PALETTE, type Script, type TextAlign, alignOffset } from "../shared/types.ts";

export interface Report {
  errors: string[];
  warnings: string[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the checker remembers about an element on the canvas. */
interface Live {
  type: string;
  /** null for paths, whose extent is their points */
  box: Box | null;
  angle?: number;
  /** text, math: which point of the box `x` is */
  align?: TextAlign;
  fontSize?: number;
  /** added with a label, which `update` may then change */
  labelled?: boolean;
  /** A line or pen stroke, in canvas coordinates, for moves along its path. */
  points?: Pt[];
  /** an arrow: what it runs between, to tell where it goes as the things at its ends move */
  arrow?: { from: string | [number, number]; to: string | [number, number]; via: Pt[]; rounded?: boolean };
}

type P = { x: number; y: number };

/** Where two segments cross, if they do, away from their ends. */
function crossing(a: P, b: P, c: P, d: P): P | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  const m = 0.04;
  return t > m && t < 1 - m && u > m && u < 1 - m ? { x: a.x + t * r.x, y: a.y + t * r.y } : null;
}

/** How long a stretch of the segment a-b lies inside the box (Liang-Barsky clipping). */
function insideLength(a: P, b: P, box: Box): number {
  let lo = 0;
  let hi = 1;
  const d = { x: b.x - a.x, y: b.y - a.y };
  for (const [p, q] of [[-d.x, a.x - box.x], [d.x, box.x + box.w - a.x], [-d.y, a.y - box.y], [d.y, box.y + box.h - a.y]]) {
    if (p === 0) {
      if (q < 0) return 0;
      continue;
    }
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r);
    else hi = Math.min(hi, r);
  }
  return hi > lo ? (hi - lo) * Math.hypot(d.x, d.y) : 0;
}

const contains = (box: Box, p: P) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;

function rotatedBox(b: Box, type: string, angle = 0): Box {
  if (!angle) return b;
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const extent = type === "ellipse" ? Math.hypot : type === "diamond" ? Math.max : (a: number, b: number) => a + b;
  const w = extent(c * b.w, s * b.h), h = extent(s * b.w, c * b.h);
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

const SHAPES = ["rectangle", "ellipse", "diamond"];
const TYPES = [...SHAPES, "text", "math", "arrow", "line", "freedraw", "image"];
const STYLE = ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "angle", "color"];
const ELEMENT_KEYS: Record<string, string[]> = {
  rectangle: ["x", "y", "width", "height", "rounded", "label", "fontSize", "fontFamily", "on"],
  ellipse: ["x", "y", "width", "height", "label", "fontSize", "fontFamily", "on"],
  diamond: ["x", "y", "width", "height", "rounded", "label", "fontSize", "fontFamily", "on"],
  text: ["x", "y", "text", "fontSize", "fontFamily", "textAlign"],
  math: ["x", "y", "tex", "fontSize", "textAlign"],
  arrow: ["from", "to", "via", "rounded", "label", "fontSize", "fontFamily", "startArrowhead", "endArrowhead"],
  line: ["points", "closed", "rounded", "fn", "domain", "range", "x", "y", "width", "height"],
  freedraw: ["points"],
  image: ["x", "y", "width", "height", "src", "on"],
};
const ENUMS: Record<string, readonly unknown[]> = {
  fillStyle: ["solid", "hachure", "cross-hatch", "zigzag"],
  strokeStyle: ["solid", "dashed", "dotted"],
  fontFamily: ["hand", "normal", "code"],
  textAlign: ["left", "center", "right"],
  startArrowhead: ["arrow", "triangle", "bar", "dot", null],
  endArrowhead: ["arrow", "triangle", "bar", "dot", null],
  enter: ["draw", "fade", "none"],
  color: Object.keys(PALETTE),
};
const VERBS = ["add", "update", "remove", "camera", "point", "send", "pulse"];
const PATHS = ["arrow", "line", "freedraw"];
const IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const COLOR = /^(transparent|#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i;
const LINE_HEIGHT = 1.25;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isColor = (v: unknown): v is string => typeof v === "string" && COLOR.test(v);
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNumber);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v: unknown) => JSON.stringify(v);
const span = (b: Box) => `x ${Math.round(b.x)} to ${Math.round(b.x + b.w)}, y ${Math.round(b.y)} to ${Math.round(b.y + b.h)}`;

function textBox(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split("\n");
  return { w: lines.reduce((width, line) => Math.max(width, widthEm(line)), 0) * fontSize, h: lines.length * fontSize * LINE_HEIGHT };
}

/** How much of a shape's width a label can use before it wraps. */
const LABEL_ROOM: Record<string, number> = { rectangle: 1, ellipse: 0.7, diamond: 0.5 };

/**
 * LaTeX where it is shown or spoken letter for letter: a common command, a group raised or lowered, or a
 * pair of dollar signs around something. Prices do not count: "$5 to $10" has a space before its second sign.
 */
const TEX_COMMANDS =
  "frac|sqrt|sum|prod|lim|cdot|times|pm|leq?|geq?|neq?|approx|equiv|infty|partial|nabla|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|mapsto|forall|exists|" +
  "alpha|beta|gamma|delta|epsilon|varepsilon|zeta|theta|lambda|mu|nu|xi|pi|rho|sigma|tau|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Psi|Omega|" +
  "mathbf|mathbb|mathcal|mathrm|ldots|cdots";
const LATEX = new RegExp(`\\\\(?:${TEX_COMMANDS})(?![a-zA-Z])|[\\^_]\\{|\\$(?![\\s$])[^$\\n]*(?<![\\s$])\\$(?!\\d)`);

/** A tab, line break or other control character: what JSON makes of `\t`, `\n`, `\f`, `\b` and `\r`. */
const CONTROL = /[\u0000-\u001f]/;

export async function check(input: unknown, baseDir: string): Promise<Report> {
  // MathJax is large and most scripts have no formulas, so it is loaded only for those that do
  const typeset: ((tex: string) => Formula) | null = JSON.stringify(input ?? null).includes('"type":"math"') ? (await import("../math/typeset.ts")).typeset : null;
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${where}: ${message}`);
  const warn = (where: string, message: string) => warnings.push(`${where}: ${message}`);

  const unknownKeys = (where: string, value: Record<string, unknown>, allowed: string[]) => {
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      // the commonest slip: a property of the action written inside what it adds or changes
      if (["at", "duration"].includes(key) && where.includes(", action ")) {
        const verb = VERBS.find((v) => where.includes(`(${v}`)) ?? "add";
        fail(where, `${quote(key)} belongs on the action, beside "${verb}": { "at": "...", "duration": 1.5, "${verb}": ... }.`);
      } else fail(where, `unknown property ${quote(key)}. Allowed: ${allowed.join(", ")}.`);
    }
  };

  /** Text and labels are drawn as typed, so LaTeX in one is a formula in the wrong place. */
  const plainText = (where: string, name: string, value: unknown) => {
    if (typeof value === "string" && LATEX.test(value)) {
      warn(where, `the ${name} ${quote(value)} looks like LaTeX, which is drawn there as typed. Put the formula in a "math" element, or type the symbol itself (α, ≤, →, x²).`);
    }
  };

  /** The size of a formula at a font size, or null (and an error) when its LaTeX cannot be typeset. */
  const formulaBox = (where: string, tex: unknown, fontSize: number): { w: number; h: number } | null => {
    if (typeof tex !== "string" || !tex.trim()) return fail(where, `needs "tex", the formula in LaTeX.`), null;
    if (CONTROL.test(tex)) {
      return fail(where, `"tex" has a tab, line break or other control character in it, which is what JSON makes of "\\t", "\\n", "\\f", "\\b" and "\\r". Write every backslash of the LaTeX twice: "\\\\theta", "\\\\frac{a}{b}".`), null;
    }
    try {
      const formula = typeset!(tex);
      return { w: formula.width * fontSize, h: formula.height * fontSize };
    } catch (e) {
      return fail(where, `the formula ${quote(tex)} could not be typeset: ${(e as Error).message}.`), null;
    }
  };

  if (!isObject(input)) return { errors: ["The file must hold a JSON object."], warnings };
  const script = input as Partial<Script> & Record<string, unknown>;
  unknownKeys("script", script, ["drawcast", "title", "canvas", "voice", "speed", "captions", "cover", "steps"]);
  if (script.drawcast !== 1) fail("script", `"drawcast" must be 1, the version of the format (got ${quote(script.drawcast)}).`);
  if (script.title !== undefined && typeof script.title !== "string") fail("script", `"title" must be text.`);
  if (script.speed !== undefined && !(isNumber(script.speed) && script.speed >= 0.5 && script.speed <= 2)) fail("script", `"speed" must be between 0.5 and 2.`);
  if (script.captions !== undefined && typeof script.captions !== "boolean") fail("script", `"captions" must be true or false.`);
  if (script.voice !== undefined && (typeof script.voice !== "string" || !script.voice.trim())) fail("voice", `must be a voice name from "drawcast voices". A voice made from a recording is no longer supported.`);

  const canvas = { ...DEFAULT_CANVAS, ...(isObject(script.canvas) ? script.canvas : {}) };
  if (script.canvas !== undefined) {
    if (!isObject(script.canvas)) fail("canvas", "must be an object.");
    else unknownKeys("canvas", script.canvas, ["width", "height", "background"]);
    if (![canvas.width, canvas.height].every((n) => isNumber(n) && n >= 100 && n <= 8000)) {
      fail("canvas", "width and height must be numbers between 100 and 8000.");
      canvas.width = DEFAULT_CANVAS.width;
      canvas.height = DEFAULT_CANVAS.height;
    }
    if (!isColor(canvas.background)) fail("canvas", `background must be a hex colour like "#ffffff".`);
  }
  if (!Array.isArray(script.steps) || !script.steps.length) return { errors: [...errors, `script: "steps" must be a list with at least one step.`], warnings };

  if (script.cover !== undefined && script.cover !== false && !(Number.isInteger(script.cover) && script.cover >= 1 && script.cover <= script.steps.length)) {
    fail("script", `"cover" must be the number of a step, 1 to ${script.steps.length}, or false for no cover (got ${quote(script.cover)}).`);
  }

  const live = new Map<string, Live>();
  const plots = new Plots();
  /** Where a point of a plot, `["loss", -2.4]`, is on the canvas; null (and an error) when it is not one. */
  const plotPoint = (where: string, name: string, ref: [string, number]): [number, number] | null => {
    if (!plots.has(ref[0])) return fail(where, `${name} ${quote(ref)} names ${quote(ref[0])}, which is not a plot (a line with "fn") on the canvas.`), null;
    return plots.point(ref) ?? (fail(where, `${name} ${quote(ref)}: the plot ${quote(ref[0])} has no value at x = ${ref[1]}.`), null);
  };
  /** A point as given, `[x, y]` or a point of a plot, in canvas coordinates; null when it is neither. */
  const anyPoint = (where: string, name: string, v: unknown): [number, number] | null => (isPoint(v) ? v : isPlotRef(v) ? plotPoint(where, name, v) : null);
  const used = new Set<string>();
  const steps = script.steps as unknown[];
  const movesCamera = steps.some((s) => isObject(s) && Array.isArray(s.do) && s.do.some((a) => isObject(a) && a.camera !== undefined));
  const captions = script.captions !== false && steps.some((s) => isObject(s) && typeof s.say === "string");
  /** captions cover the bottom of the picture */
  const floor = canvas.height * (captions ? 0.86 : 1);

  const checkStyle = (where: string, el: Record<string, unknown>) => {
    for (const key of ["strokeColor", "backgroundColor"]) {
      if (el[key] !== undefined && !isColor(el[key])) fail(where, `${key} must be a hex colour like "#1971c2" or "transparent" (got ${quote(el[key])}).`);
    }
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (el[key] !== undefined && !allowed.includes(el[key])) fail(where, `${key} must be one of ${allowed.map(quote).join(", ")} (got ${quote(el[key])}).`);
    }
    for (const [key, lo, hi] of [["strokeWidth", 0.5, 20], ["roughness", 0, 3], ["opacity", 0, 100], ["fontSize", 8, 400]] as const) {
      if (el[key] !== undefined && !(isNumber(el[key]) && el[key] >= lo && el[key] <= hi)) fail(where, `${key} must be a number from ${lo} to ${hi}.`);
    }
    if (el.angle !== undefined && !isNumber(el.angle)) fail(where, "angle must be a number (radians).");
  };

  /** An arrow end or a pointer target: an element on the canvas, or a point. */
  const checkRef = (where: string, name: string, ref: unknown, attachable = false): boolean => {
    if (isPoint(ref)) return true;
    if (isPlotRef(ref)) return !!plotPoint(where, name, ref);
    if (typeof ref !== "string") return fail(where, `${name} must be an element id or a point [x, y].`), false;
    const target = live.get(ref);
    if (!target) return fail(where, `${name} refers to ${quote(ref)}, which is not on the canvas at this point (never added, or already removed).`), false;
    if (attachable && PATHS.includes(target.type)) return fail(where, `${name} refers to ${quote(ref)}, a ${target.type}; arrows attach to shapes, text, math and images. Give a point [x, y] instead.`), false;
    return true;
  };

  const place = (where: string, id: string, type: string, base: Box | null, anchor: Omit<Live, "type" | "box"> = {}) => {
    const box = base && rotatedBox(base, type, anchor.angle);
    if (box && !movesCamera) {
      if (box.x < 0 || box.y < 0 || box.x + box.w > canvas.width || box.y + box.h > canvas.height) {
        warn(where, `extends past the canvas (${canvas.width} x ${canvas.height}); it spans ${span(box)}.`);
      } else if (box.y + box.h > floor) {
        warn(where, `sits under the captions, which cover the canvas below y ${Math.round(floor)}; it spans ${span(box)}. Move it up, or set "captions": false.`);
      }
    }
    // a plot's box is its axes' room: things sit on its curve on purpose
    if (box && type !== "line") {
      for (const [otherId, other] of live) {
        if (!other.box || other.type === "line") continue;
        const a = box;
        const o = rotatedBox(other.box, other.type, other.angle);
        const overlaps = a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h;
        const inside = (p: Box, q: Box) => p.x >= q.x && p.y >= q.y && p.x + p.w <= q.x + q.w && p.y + p.h <= q.y + q.h;
        if (overlaps && !inside(a, o) && !inside(o, a)) warn(where, `partly overlaps ${quote(otherId)} (${span(o)}); this one spans ${span(a)}. Separate them, or put one fully inside the other.`);
      }
    }
    live.set(id, { type, box: base, ...anchor });
  };

  const addElement = (where: string, value: unknown) => {
    if (!isObject(value)) return fail(where, "an element must be an object.");
    let el = value as Record<string, unknown> & Partial<ElementSpec>;
    const type = el.type;
    if (typeof type !== "string" || !TYPES.includes(type)) return fail(where, `"type" must be one of ${TYPES.join(", ")} (got ${quote(el.type)}).`);
    unknownKeys(where, el, ["id", "type", ...ELEMENT_KEYS[type], ...STYLE, "enter"]);
    checkStyle(where, el);
    for (const key of ["rounded", "closed"]) {
      if (el[key] !== undefined && typeof el[key] !== "boolean") fail(where, `${key} must be true or false.`);
    }
    if (el.label !== undefined && typeof el.label !== "string") fail(where, `"label" must be text.`);
    if (typeof el.id !== "string" || !el.id) return fail(where, `needs an "id".`);
    if (used.has(el.id)) fail(where, `the id ${quote(el.id)} is already used; every element needs its own.`);
    used.add(el.id);
    const id = el.id;

    const need = (keys: string[]) => {
      const missing = keys.filter((k) => !isNumber(el[k]));
      if (missing.length) fail(where, `needs numeric ${missing.join(", ")}.`);
      return !missing.length;
    };
    let box: Box | null = null;
    let anchor: Pick<Live, "align" | "fontSize" | "points"> = {};
    plainText(where, "label", el.label);

    if (el.on !== undefined) {
      const at = isPlotRef(el.on) ? plotPoint(where, "on", el.on) : (fail(where, `"on" must be a point of a plot, such as ["loss", -2.4].`), null);
      if (!at) return;
      if (!isNumber(el.width) || !isNumber(el.height)) return fail(where, `"on" puts the element's middle on the point, so it needs width and height.`);
      if (el.x !== undefined || el.y !== undefined) fail(where, `"on" says where the element goes; leave out x and y.`);
      el = { ...el, x: at[0] - el.width / 2, y: at[1] - el.height / 2 };
    }
    if (SHAPES.includes(type)) {
      if (!need(["x", "y", "width", "height"])) return;
      if (el.width! <= 0 || el.height! <= 0) return fail(where, "width and height must be positive.");
      box = { x: el.x!, y: el.y!, w: el.width!, h: el.height! };
      if (typeof el.label === "string" && el.label) {
        const fontSize = isNumber(el.fontSize) ? el.fontSize : 20;
        const room = Math.max(10, el.width! * LABEL_ROOM[type] - 20);
        const lines = el.label.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((widthEm(line) * fontSize) / room)), 0);
        if (lines * fontSize * LINE_HEIGHT + 12 > el.height! * (type === "rectangle" ? 1 : 0.75)) {
          warn(where, `the label ${quote(el.label)} needs about ${lines} line(s) and will not fit; make the shape wider or taller, or shorten the label.`);
        }
      }
    } else if (type === "text") {
      if (typeof el.text !== "string" || !el.text.trim()) return fail(where, `needs "text".`);
      if (!need(["x", "y"])) return;
      plainText(where, "text", el.text);
      const fontSize = isNumber(el.fontSize) ? el.fontSize : 20;
      const size = textBox(el.text, fontSize);
      anchor = { align: el.textAlign, fontSize };
      box = { x: el.x! - alignOffset(size.w, el.textAlign), y: el.y!, ...size };
    } else if (type === "math") {
      const fontSize = isNumber(el.fontSize) ? el.fontSize : 20;
      const size = formulaBox(where, el.tex, fontSize);
      if (!need(["x", "y"]) || !size) return;
      anchor = { align: el.textAlign, fontSize };
      box = { x: el.x! - alignOffset(size.w, el.textAlign), y: el.y!, ...size };
    } else if (type === "image") {
      if (typeof el.src !== "string") return fail(where, `needs "src", the path of an image file.`);
      if (!IMAGE_TYPES.includes(path.extname(el.src).toLowerCase())) return fail(where, `src must be one of ${IMAGE_TYPES.join(", ")}.`);
      try {
        if (!statSync(path.resolve(baseDir, el.src)).isFile()) return fail(where, `the image ${quote(el.src)} must be a file.`);
      } catch {
        return fail(where, `the image ${quote(el.src)} was not found or could not be accessed (paths are relative to the script).`);
      }
      for (const key of ["width", "height"] as const) {
        if (el[key] !== undefined && !(isNumber(el[key]) && el[key] > 0)) fail(where, `${key} must be a positive number.`);
      }
      if (!need(["x", "y"])) return;
      // without the file's proportions the height is unknown; overlap checks need both
      if (isNumber(el.width) && isNumber(el.height)) box = { x: el.x!, y: el.y!, w: el.width, h: el.height };
    } else if (type === "arrow") {
      const ok = [checkRef(where, "from", el.from, true), checkRef(where, "to", el.to, true)];
      if (ok.every(Boolean) && typeof el.from === "string" && el.from === el.to) fail(where, "an arrow cannot start and end on the same element.");
      if (el.via !== undefined && !(Array.isArray(el.via) && el.via.every((p) => isPoint(p) || isPlotRef(p)))) fail(where, `"via" must be a list of points [[x, y], ...].`);
      else if (ok.every(Boolean)) {
        const end = (r: unknown) => (typeof r === "string" ? r : anyPoint(where, "an end", r) ?? [0, 0]);
        const arrow = { from: end(el.from), to: end(el.to), via: pathPoints(where, "via", el.via ?? []), rounded: el.rounded === true };
        place(where, id, type, null, { labelled: typeof el.label === "string" && !!el.label, arrow });
        crossings(where, id);
        // a label sits on the middle of the arrow: on a short one it covers the shaft and the head
        const path = course(arrow);
        if (path && typeof el.label === "string" && el.label) {
          const center = arrowLabelCenter(path);
          const { w, h } = textBox(el.label, isNumber(el.fontSize) ? el.fontSize : 16);
          const label = { x: center.x - w / 2, y: center.y - h / 2, w, h };
          let length = 0, covered = 0;
          for (let i = 1; i < path.length; i++) {
            length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
            covered += insideLength(path[i - 1], path[i], label);
          }
          if (length - covered < 50) {
            warn(where, `the label ${quote(el.label)} spans about ${Math.round(covered)} of the arrow's ${Math.round(length)} units: it will cover the arrow. Move the ends apart, or put the label beside the arrow.`);
          }
        }
        return;
      }
    } else if (type === "line" && el.fn !== undefined) {
      if (typeof el.fn !== "string") return fail(where, `"fn" must be a function of x, such as "x^2 / 4".`);
      if (!need(["x", "y", "width", "height"])) return;
      if (el.width! <= 0 || el.height! <= 0) return fail(where, "width and height must be positive.");
      if (el.points !== undefined) fail(where, `a plot uses "fn" to generate its points. Give either "fn" or "points".`);
      const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isNumber) && v[0] < v[1];
      if (!pair(el.domain)) return fail(where, `a plot needs "domain": [from, to], the x values its box spans, smaller first.`);
      if (el.range !== undefined && !pair(el.range)) return fail(where, `"range" must be [bottom, top], the y values its box spans, smaller first.`);
      try {
        const segments = plots.add({ ...el, angle: isNumber(el.angle) ? el.angle : 0 } as ElementSpec);
        if (!segments.length) return fail(where, `"${el.fn}" has no values to draw across ${quote(el.domain)}${el.range ? ` within ${quote(el.range)}` : ""}.`);
        anchor.points = segments.flatMap((segment, i) => segment.map(([x, y], j) => ({ x, y, move: i > 0 && j === 0 })));
      } catch (e) {
        return fail(where, `"fn" could not be read: ${(e as Error).message}. Write it as on paper: x^2 / 4, 2 sin(x), exp(-x^2), sqrt(x) + 1.`);
      }
      box = { x: el.x!, y: el.y!, w: el.width!, h: el.height! };
    } else {
      const plotOnly = ["x", "y", "width", "height", "domain", "range"].filter((k) => el[k] !== undefined);
      if (plotOnly.length) fail(where, `${plotOnly.join(", ")} are for a plot, a line with "fn". A line is placed by its "points".`);
      const min = el.closed ? 3 : 2;
      if (!Array.isArray(el.points) || el.points.length < min || !el.points.every((p) => isPoint(p) || isPlotRef(p))) return fail(where, `needs "points": at least ${min} points [[x, y], ...] in canvas coordinates.`);
      anchor.points = pathPoints(where, "a point", el.points);
      if (el.closed && anchor.points.length) anchor.points.push(anchor.points[0]);
    }
    place(where, id, type, box, { ...anchor, angle: isNumber(el.angle) ? el.angle : 0, labelled: typeof el.label === "string" && !!el.label });
  };

  const pathPoints = (where: string, name: string, refs: unknown[]): Pt[] => {
    const valid = refs.map((ref) => anyPoint(where, name, ref));
    return valid.every(Boolean) ? plots.path(refs as ([number, number] | PlotRef)[]) : [];
  };

  /** Resolve the arrow using the same outline and curve geometry the player draws. */
  const course = (arrow: NonNullable<Live["arrow"]>): P[] | null => {
    const end = (ref: string | [number, number]): ArrowEnd | null => {
      if (Array.isArray(ref)) return { x: ref[0], y: ref[1] };
      const el = live.get(ref);
      if (!el?.box) return null;
      return { type: el.type, angle: el.angle, x: el.box.x, y: el.box.y, width: el.box.w, height: el.box.h };
    };
    const from = end(arrow.from);
    const to = end(arrow.to);
    return from && to ? arrowCourse(from, to, arrow.via, arrow.rounded) : null;
  };

  /** Warns when a new arrow crosses an arrow already there, or runs through something that is not one of its ends. */
  const crossings = (where: string, id: string) => {
    const mine = live.get(id)!.arrow!;
    const path = course(mine);
    if (!path) return;
    const ends = [mine.from, mine.to].filter((r): r is string => typeof r === "string");
    for (const [otherId, other] of live) {
      if (otherId === id) continue;
      if (other.arrow) {
        const shared = [other.arrow.from, other.arrow.to].some((r) => typeof r === "string" && ends.includes(r));
        const theirs = course(other.arrow);
        if (shared || !theirs) continue;
        for (let i = 1; i < path.length; i++) {
          for (let j = 1; j < theirs.length; j++) {
            const at = crossing(path[i - 1], path[i], theirs[j - 1], theirs[j]);
            if (at) {
              warn(where, `crosses the arrow ${quote(otherId)} at about (${Math.round(at.x)}, ${Math.round(at.y)}). Move an element so they do not cross, or route one around the other with "via".`);
              return;
            }
          }
        }
      } else if (other.box && !ends.includes(otherId) && ["rectangle", "ellipse", "diamond", "text", "math", "image"].includes(other.type)) {
        // a container of either end, something the arrow starts or ends inside, or a part of one of its ends, is not in its way
        if (contains(other.box, path[0]) || contains(other.box, path[path.length - 1])) continue;
        const o = other.box;
        const within = (b: Box | null | undefined) => !!b && o.x >= b.x && o.y >= b.y && o.x + o.w <= b.x + b.w && o.y + o.h <= b.y + b.h;
        if (ends.some((end) => within(live.get(end)?.box))) continue;
        const shrunk = { x: other.box.x + 4, y: other.box.y + 4, w: other.box.w - 8, h: other.box.h - 8 };
        if (path.slice(1).some((p, i) => insideLength(path[i], p, shrunk) > 6)) {
          warn(where, `runs through ${quote(otherId)} (${span(other.box)}), which is not one of its ends. Move it, or route the arrow around it with "via".`);
        }
      }
    }
  };

  steps.forEach((value, si) => {
    const at = `step ${si + 1}`;
    if (!isObject(value)) return fail(at, "a step must be an object.");
    unknownKeys(at, value, ["say", "do", "pause", "duration"]);
    const say = value.say;
    if (say !== undefined && (typeof say !== "string" || !tokens(say).length)) fail(at, `"say" must be text with at least one word.`);
    else if (typeof say === "string" && LATEX.test(say)) {
      warn(at, `"say" has LaTeX in it: the voice says only the letters and numbers of it, and the captions show it as typed. Write the formula the way it is said ("x squared"), and show it in a "math" element.`);
    }
    if (value.do !== undefined && !Array.isArray(value.do)) fail(at, `"do" must be a list of actions.`);
    for (const key of ["pause", "duration"]) {
      if (value[key] !== undefined && !(isNumber(value[key]) && value[key] >= 0 && value[key] <= 60)) fail(at, `"${key}" must be a number of seconds from 0 to 60.`);
    }
    if (say !== undefined && value.duration !== undefined) fail(at, `"duration" is for steps without "say"; a spoken step lasts as long as its narration.`);
    const actions = Array.isArray(value.do) ? value.do : [];
    if (say === undefined && !actions.length && value.duration === undefined) fail(at, `has nothing to say or do. Give it "say", "do" or "duration".`);

    const said = typeof say === "string" ? tokens(say) : [];
    let anchor = 0;
    let offset = 0;
    actions.forEach((raw, ai) => {
      if (!isObject(raw)) return fail(`${at}, action ${ai + 1}`, "an action must be an object.");
      const verbs = VERBS.filter((v) => raw[v] !== undefined);
      const id = isObject(raw.add) ? raw.add.id : isObject(raw.update) ? raw.update.id : (raw.remove ?? raw.point ?? raw.pulse ?? (isObject(raw.send) ? raw.send.along : raw.send));
      const where = `${at}, action ${ai + 1}${verbs.length === 1 ? ` (${verbs[0]}${typeof id === "string" ? ` ${quote(id)}` : ""})` : ""}`;
      unknownKeys(where, raw, ["at", "duration", "enter", ...VERBS]);
      if (verbs.length !== 1) return fail(where, `needs exactly one of ${VERBS.join(", ")}.`);
      if (raw.enter !== undefined && !raw.add) fail(where, `"enter" only applies to "add".`);
      checkStyle(where, { enter: raw.enter });
      if (raw.duration !== undefined && !(isNumber(raw.duration) && raw.duration >= 0 && raw.duration <= 60)) fail(where, `"duration" must be a number of seconds from 0 to 60.`);

      if (typeof raw.at === "string") {
        const phrase = tokens(raw.at);
        if (typeof say !== "string") fail(where, `"at": ${quote(raw.at)} names a spoken phrase, but this step has no "say". Use seconds instead.`);
        else if (!phrase.length || findPhrase(phrase, said) < 0) fail(where, `"at": ${quote(raw.at)} is not in this step's "say". Copy a word or short phrase from it exactly.`);
        else {
          const found = findPhrase(phrase, said, anchor);
          if (found < 0) fail(where, `"at": ${quote(raw.at)} is spoken before the previous action's phrase. Actions run in the order listed: reorder them, pick a later phrase, or reword "say".`);
          else anchor = found;
        }
      } else if (isNumber(raw.at)) {
        if (raw.at < offset) fail(where, `"at": ${raw.at} is earlier than the previous action's ${offset}. Actions must be listed in the order they happen.`);
        offset = Math.max(offset, raw.at);
      } else if (raw.at !== undefined) fail(where, `"at" must be a phrase from "say" or a number of seconds.`);

      if (raw.add !== undefined) {
        if (Array.isArray(raw.add) && !raw.add.length) fail(where, `"add" needs at least one element.`);
        for (const el of Array.isArray(raw.add) ? raw.add : [raw.add]) addElement(where, el);
      } else if (raw.update !== undefined) {
        const u = raw.update;
        if (!isObject(u)) return fail(where, `"update" must be an object with an "id".`);
        unknownKeys(where, u, ["id", "x", "y", "dx", "dy", "width", "height", "text", "tex", "label", "along", "span", "fontSize", ...STYLE]);
        checkStyle(where, u);
        plainText(where, "text", u.text);
        const ids = Array.isArray(u.id) ? u.id : [u.id];
        if (!ids.length) fail(where, `"update" needs at least one element id.`);
        for (const key of ["x", "y", "dx", "dy"]) if (u[key] !== undefined && !isNumber(u[key])) fail(where, `${key} must be a number.`);
        for (const key of ["width", "height"]) if (u[key] !== undefined && !(isNumber(u[key]) && u[key] > 0)) fail(where, `${key} must be a positive number.`);
        for (const key of ["text", "label"]) if (u[key] !== undefined && typeof u[key] !== "string") fail(where, `"${key}" must be text.`);
        if (u.label !== undefined) plainText(where, "label", u.label);
        /** with `along`: where the travel ends, which is where each element's middle is afterwards */
        let arrival: P | null = null;
        if (u.along !== undefined) {
          let route: Pt[] | null = null;
          if (Array.isArray(u.along) && u.along.length >= 2 && u.along.every((p) => isPoint(p) || isPlotRef(p))) {
            route = pathPoints(where, "along", u.along);
          }
          else if (typeof u.along === "string" && checkRef(where, "along", u.along)) {
            const path = live.get(u.along)!;
            if (!PATHS.includes(path.type)) fail(where, `"along" names ${quote(u.along)}, a ${path.type}; it must be an arrow or a line to travel along, or points [[x, y], ...].`);
            else route = path.arrow ? course(path.arrow) : path.points ?? null;
          } else if (typeof u.along !== "string") fail(where, `"along" must be the id of an arrow or line, or at least two points [[x, y], ...].`);
          if (u.span !== undefined && !(Array.isArray(u.span) && u.span.length === 2 && u.span.every(isNumber) && 0 <= u.span[0] && u.span[0] < u.span[1] && u.span[1] <= 1)) {
            fail(where, `"span" must be [from, to], fractions of the path between 0 and 1, smaller first.`);
          }
          if (route?.length) arrival = partialPolyline(route, Array.isArray(u.span) && isNumber(u.span[1]) ? u.span[1] : 1).at(-1)!;
          if (["x", "y", "dx", "dy"].some((k) => u[k] !== undefined)) fail(where, `"along" says where the element ends up; leave out x, y, dx and dy.`);
        } else if (u.span !== undefined) fail(where, `"span" only goes with "along".`);
        for (const target of ids) {
          if (!checkRef(where, "id", typeof target === "string" ? target : undefined)) continue;
          const el = live.get(target as string)!;
          if (PATHS.includes(el.type) && ["x", "y", "width", "height"].some((k) => u[k] !== undefined)) {
            fail(where, `${quote(target)} is a ${el.type}; move it with dx and dy (x, y, width and height are for shapes, text and images).`);
          }
          if (u.text !== undefined && el.type !== "text") {
            fail(where, `"text" can only replace the content of a text element; ${quote(target)} is a ${el.type}${el.type === "math" ? `, whose formula is replaced with "tex"` : ""}.`);
          }
          if (u.tex !== undefined && el.type !== "math") fail(where, `"tex" can only replace the formula of a math element; ${quote(target)} is a ${el.type}.`);
          if (el.type === "math" && (u.width !== undefined || u.height !== undefined)) fail(where, `${quote(target)} is a formula, which cannot be stretched: its size is the fontSize it was added with.`);
          if (u.label !== undefined && !el.labelled) {
            fail(where, `${quote(target)} was added without a label, so there is none to change. Give it one when it is added${el.type === "text" ? `; a text element changes with "text"` : ""}.`);
          }
          if (u.fontSize !== undefined && !["text", "math"].includes(el.type)) {
            fail(where, `"fontSize" changes the size of a text or math element; ${quote(target)} is a ${el.type}${SHAPES.includes(el.type) ? ", which changes size with width and height" : ""}.`);
          }
          if (u.along !== undefined && PATHS.includes(el.type)) fail(where, `${quote(target)} is a ${el.type}, which cannot travel; use a shape, text or image. To send something along an arrow, use "send".`);
          const dx = isNumber(u.dx) ? u.dx : 0;
          const dy = isNumber(u.dy) ? u.dy : 0;
          if (isNumber(u.angle)) el.angle = u.angle;
          plots.move(target as string, dx, dy, isNumber(u.angle) ? u.angle : undefined);
          if (el.arrow && (dx || dy)) {
            const path = course(el.arrow);
            if (path) el.arrow = { from: [path[0].x + dx, path[0].y + dy], to: [path.at(-1)!.x + dx, path.at(-1)!.y + dy], via: path.slice(1, -1).map((p) => ({ x: p.x + dx, y: p.y + dy })) };
          }
          if (el.points && (dx || dy)) el.points = el.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
          const fontSize = isNumber(u.fontSize) ? u.fontSize : el.fontSize;
          const formula = el.type === "math" && u.tex !== undefined ? formulaBox(where, u.tex, fontSize ?? 20) : null;
          if (el.box) {
            const b = el.box;
            const text = el.type === "text" && typeof u.text === "string" ? textBox(u.text, fontSize ?? 20) : null;
            const scale = el.fontSize && fontSize ? fontSize / el.fontSize : 1;
            const w = formula?.w ?? text?.w ?? (isNumber(u.width) ? u.width : b.w * scale);
            const h = formula?.h ?? text?.h ?? (isNumber(u.height) ? u.height : b.h * scale);
            // `x` is the point the element was placed by, which for centred text is its middle
            const x = isNumber(u.x) ? u.x : b.x + alignOffset(b.w, el.align);
            el.box = {
              x: arrival ? arrival.x - w / 2 : x - alignOffset(w, el.align) + dx,
              y: arrival ? arrival.y - h / 2 : (isNumber(u.y) ? u.y : b.y) + dy,
              w, h,
            };
            if (el.fontSize !== undefined) el.fontSize = fontSize;
          }
        }
      } else if (raw.remove !== undefined) {
        const ids = Array.isArray(raw.remove) ? raw.remove : [raw.remove];
        if (!ids.length) fail(where, `"remove" needs at least one element id.`);
        for (const target of ids) {
          if (typeof target === "string" && checkRef(where, "remove", target)) {
            for (const { arrow } of live.values()) {
              if (!arrow || (arrow.from !== target && arrow.to !== target)) continue;
              const path = course(arrow);
              if (!path) continue;
              if (arrow.from === target) arrow.from = [path[0].x, path[0].y];
              if (arrow.to === target) arrow.to = [path.at(-1)!.x, path.at(-1)!.y];
            }
            live.delete(target);
            plots.remove(target);
          } else if (typeof target !== "string") fail(where, `"remove" needs an element id.`);
        }
      } else if (raw.camera !== undefined) {
        const c = raw.camera;
        if (c === "reset") return;
        if (!isObject(c)) return fail(where, `"camera" must be "reset", { x, y, width } or { fit }.`);
        if (c.fit !== undefined) {
          unknownKeys(where, c, ["fit", "padding"]);
          if (c.padding !== undefined && !(isNumber(c.padding) && c.padding >= 0)) fail(where, `"padding" must be a nonnegative number.`);
          if (c.fit !== "all" && !(Array.isArray(c.fit) && c.fit.length)) return fail(where, `"fit" must be "all" or a list of element ids.`);
          if (Array.isArray(c.fit)) for (const target of c.fit) checkRef(where, "fit", typeof target === "string" ? target : undefined);
        } else {
          unknownKeys(where, c, ["x", "y", "width"]);
          if (!(isNumber(c.x) && isNumber(c.y) && isNumber(c.width) && c.width > 0)) fail(where, `"camera" needs numeric x, y and a positive width (the height follows from the canvas).`);
        }
      } else if (raw.send !== undefined) {
        const s = raw.send;
        const spec = isObject(s) ? s : { along: s };
        if (isObject(s)) {
          unknownKeys(where, s, ["along", "color", "reverse"]);
          if (s.reverse !== undefined && typeof s.reverse !== "boolean") fail(where, `"reverse" must be true or false.`);
          if (s.color !== undefined && !(typeof s.color === "string" && (Object.hasOwn(PALETTE, s.color) || isColor(s.color)))) fail(where, `"color" must be a colour name (${Object.keys(PALETTE).join(", ")}) or a hex colour.`);
        }
        const ids = Array.isArray(spec.along) ? spec.along : [spec.along];
        if (!ids.length) fail(where, `"send" needs the id of an arrow or line, or a list of them.`);
        for (const target of ids) {
          if (!checkRef(where, "send", typeof target === "string" ? target : undefined)) continue;
          const el = live.get(target as string)!;
          if (!PATHS.includes(el.type)) fail(where, `"send" runs along arrows and lines; ${quote(target)} is a ${el.type}. To move it, use "update" with "along".`);
        }
      } else if (raw.pulse !== undefined) {
        const ids = Array.isArray(raw.pulse) ? raw.pulse : [raw.pulse];
        if (!ids.length) fail(where, `"pulse" needs at least one element id.`);
        for (const target of ids) checkRef(where, "pulse", typeof target === "string" ? target : undefined);
      } else checkRef(where, "point", raw.point);
    });
  });

  if (!used.size) warnings.push("script: nothing is ever drawn.");
  return { errors, warnings };
}
