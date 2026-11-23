/**
 * Checks a script before anything is spoken or drawn.
 *
 * Errors are things the renderer cannot act on (an arrow to an element that does not exist, a phrase the
 * narration never says). Warnings are things it can draw but a viewer would probably not want (two boxes
 * half on top of each other, a label too long for its shape). Whoever wrote the script usually cannot see
 * the picture, so every message says where the problem is and what would fix it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { findPhrase, tokens, widthEm } from "../shared/text.ts";
import { DEFAULT_CANVAS, type ElementSpec, type Script } from "../shared/types.ts";

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
}

const SHAPES = ["rectangle", "ellipse", "diamond"];
const TYPES = [...SHAPES, "text", "arrow", "line", "freedraw", "image"];
const STYLE = ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "angle"];
const ELEMENT_KEYS: Record<string, string[]> = {
  rectangle: ["x", "y", "width", "height", "rounded", "label", "fontSize", "fontFamily"],
  ellipse: ["x", "y", "width", "height", "label", "fontSize", "fontFamily"],
  diamond: ["x", "y", "width", "height", "rounded", "label", "fontSize", "fontFamily"],
  text: ["x", "y", "text", "fontSize", "fontFamily", "textAlign"],
  arrow: ["from", "to", "via", "rounded", "label", "fontSize", "fontFamily", "startArrowhead", "endArrowhead"],
  line: ["points", "closed", "rounded"],
  freedraw: ["points"],
  image: ["x", "y", "width", "height", "src"],
};
const ENUMS: Record<string, readonly unknown[]> = {
  fillStyle: ["solid", "hachure", "cross-hatch", "zigzag"],
  strokeStyle: ["solid", "dashed", "dotted"],
  fontFamily: ["hand", "normal", "code"],
  textAlign: ["left", "center", "right"],
  startArrowhead: ["arrow", "triangle", "bar", "dot", null],
  endArrowhead: ["arrow", "triangle", "bar", "dot", null],
  enter: ["draw", "fade", "none"],
};
const VERBS = ["add", "update", "remove", "camera", "point"];
const IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const COLOR = /^(transparent|#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i;
const LINE_HEIGHT = 1.25;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNumber);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v: unknown) => JSON.stringify(v);
const span = (b: Box) => `x ${Math.round(b.x)} to ${Math.round(b.x + b.w)}, y ${Math.round(b.y)} to ${Math.round(b.y + b.h)}`;

function textBox(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split("\n");
  return { w: Math.max(...lines.map(widthEm)) * fontSize, h: lines.length * fontSize * LINE_HEIGHT };
}

/** How much of a shape's width a label can use before it wraps. */
const LABEL_ROOM: Record<string, number> = { rectangle: 1, ellipse: 0.7, diamond: 0.5 };

export function check(input: unknown, baseDir: string): Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (where: string, message: string) => errors.push(`${where}: ${message}`);
  const warn = (where: string, message: string) => warnings.push(`${where}: ${message}`);

  const unknownKeys = (where: string, value: Record<string, unknown>, allowed: string[]) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `unknown property ${quote(key)}. Allowed: ${allowed.join(", ")}.`);
  };

  if (!isObject(input)) return { errors: ["The file must hold a JSON object."], warnings };
  const script = input as Partial<Script> & Record<string, unknown>;
  unknownKeys("script", script, ["drawcast", "title", "canvas", "voice", "speed", "captions", "steps"]);
  if (script.drawcast !== 1) fail("script", `"drawcast" must be 1, the version of the format (got ${quote(script.drawcast)}).`);
  if (script.speed !== undefined && !(isNumber(script.speed) && script.speed >= 0.5 && script.speed <= 2)) fail("script", `"speed" must be between 0.5 and 2.`);
  if (script.captions !== undefined && typeof script.captions !== "boolean") fail("script", `"captions" must be true or false.`);
  if (isObject(script.voice)) {
    if (typeof script.voice.clip !== "string" || typeof script.voice.transcript !== "string") fail("voice", `a custom voice needs "clip" (a WAV file) and "transcript" (exactly what the clip says).`);
    else if (!existsSync(path.resolve(baseDir, script.voice.clip))) fail("voice", `the clip ${quote(script.voice.clip)} was not found (paths are relative to the script).`);
  } else if (script.voice !== undefined && typeof script.voice !== "string") fail("voice", "must be a voice name or { clip, transcript }.");

  const canvas = { ...DEFAULT_CANVAS, ...(isObject(script.canvas) ? script.canvas : {}) };
  if (script.canvas !== undefined) {
    if (!isObject(script.canvas)) fail("canvas", "must be an object.");
    else unknownKeys("canvas", script.canvas, ["width", "height", "background"]);
    if (![canvas.width, canvas.height].every((n) => isNumber(n) && n >= 100 && n <= 8000)) fail("canvas", "width and height must be numbers between 100 and 8000.");
    if (!COLOR.test(String(canvas.background))) fail("canvas", `background must be a hex colour like "#ffffff".`);
  }
  if (!Array.isArray(script.steps) || !script.steps.length) return { errors: [...errors, `script: "steps" must be a list with at least one step.`], warnings };

  const live = new Map<string, Live>();
  const used = new Set<string>();
  const steps = script.steps as unknown[];
  const movesCamera = steps.some((s) => isObject(s) && Array.isArray(s.do) && s.do.some((a) => isObject(a) && a.camera !== undefined));
  const captions = script.captions !== false && steps.some((s) => isObject(s) && typeof s.say === "string");
  /** captions cover the bottom of the picture */
  const floor = canvas.height * (captions ? 0.86 : 1);

  const checkStyle = (where: string, el: Record<string, unknown>) => {
    for (const key of ["strokeColor", "backgroundColor"]) {
      if (el[key] !== undefined && !COLOR.test(String(el[key]))) fail(where, `${key} must be a hex colour like "#1971c2" or "transparent" (got ${quote(el[key])}).`);
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
    if (typeof ref !== "string") return fail(where, `${name} must be an element id or a point [x, y].`), false;
    const target = live.get(ref);
    if (!target) return fail(where, `${name} refers to ${quote(ref)}, which is not on the canvas at this point (never added, or already removed).`), false;
    if (attachable && !target.box) return fail(where, `${name} refers to ${quote(ref)}, a ${target.type}; arrows attach to shapes, text and images. Give a point [x, y] instead.`), false;
    return true;
  };

  const place = (where: string, id: string, type: string, box: Box | null) => {
    if (box && !movesCamera) {
      if (box.x < 0 || box.y < 0 || box.x + box.w > canvas.width || box.y + box.h > canvas.height) {
        warn(where, `extends past the canvas (${canvas.width} x ${canvas.height}); it spans ${span(box)}.`);
      } else if (box.y + box.h > floor) {
        warn(where, `sits under the captions, which cover the canvas below y ${Math.round(floor)}; it spans ${span(box)}. Move it up, or set "captions": false.`);
      }
    }
    if (box) {
      for (const [otherId, other] of live) {
        if (!other.box) continue;
        const a = box;
        const o = other.box;
        const overlaps = a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h;
        const inside = (p: Box, q: Box) => p.x >= q.x && p.y >= q.y && p.x + p.w <= q.x + q.w && p.y + p.h <= q.y + q.h;
        if (overlaps && !inside(a, o) && !inside(o, a)) warn(where, `partly overlaps ${quote(otherId)} (${span(o)}); this one spans ${span(a)}. Separate them, or put one fully inside the other.`);
      }
    }
    live.set(id, { type, box });
  };

  const addElement = (where: string, value: unknown) => {
    if (!isObject(value)) return fail(where, "an element must be an object.");
    const el = value as Record<string, unknown> & Partial<ElementSpec>;
    const type = String(el.type);
    if (!TYPES.includes(type)) return fail(where, `"type" must be one of ${TYPES.join(", ")} (got ${quote(el.type)}).`);
    unknownKeys(where, el, ["id", "type", ...ELEMENT_KEYS[type], ...STYLE]);
    checkStyle(where, el);
    if (typeof el.id !== "string" || !el.id) return fail(where, `needs an "id".`);
    if (used.has(el.id)) fail(where, `the id ${quote(el.id)} is already used; every element needs its own.`);
    used.add(el.id);

    const need = (keys: string[]) => {
      const missing = keys.filter((k) => !isNumber(el[k]));
      if (missing.length) fail(where, `needs numeric ${missing.join(", ")}.`);
      return !missing.length;
    };
    let box: Box | null = null;

    if (SHAPES.includes(type)) {
      if (!need(["x", "y", "width", "height"])) return;
      if (el.width! <= 0 || el.height! <= 0) return fail(where, "width and height must be positive.");
      box = { x: el.x!, y: el.y!, w: el.width!, h: el.height! };
      if (typeof el.label === "string" && el.label) {
        const fontSize = el.fontSize ?? 20;
        const room = Math.max(10, el.width! * LABEL_ROOM[type] - 20);
        const lines = el.label.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((widthEm(line) * fontSize) / room)), 0);
        if (lines * fontSize * LINE_HEIGHT + 12 > el.height! * (type === "rectangle" ? 1 : 0.75)) {
          warn(where, `the label ${quote(el.label)} needs about ${lines} line(s) and will not fit; make the shape wider or taller, or shorten the label.`);
        }
      }
    } else if (type === "text") {
      if (typeof el.text !== "string" || !el.text.trim()) return fail(where, `needs "text".`);
      if (!need(["x", "y"])) return;
      box = { x: el.x!, y: el.y!, ...textBox(el.text, el.fontSize ?? 20) };
    } else if (type === "image") {
      if (typeof el.src !== "string") return fail(where, `needs "src", the path of an image file.`);
      if (!IMAGE_TYPES.includes(path.extname(el.src).toLowerCase())) return fail(where, `src must be one of ${IMAGE_TYPES.join(", ")}.`);
      if (!existsSync(path.resolve(baseDir, el.src))) return fail(where, `the image ${quote(el.src)} was not found (paths are relative to the script).`);
      if (!need(["x", "y"])) return;
      // without the file's proportions the height is unknown; overlap checks need both
      if (isNumber(el.width) && isNumber(el.height)) box = { x: el.x!, y: el.y!, w: el.width, h: el.height };
    } else if (type === "arrow") {
      const ok = [checkRef(where, "from", el.from, true), checkRef(where, "to", el.to, true)];
      if (ok.every(Boolean) && typeof el.from === "string" && el.from === el.to) fail(where, "an arrow cannot start and end on the same element.");
      if (el.via !== undefined && !(Array.isArray(el.via) && el.via.every(isPoint))) fail(where, `"via" must be a list of points [[x, y], ...].`);
    } else {
      const min = el.closed ? 3 : 2;
      if (!Array.isArray(el.points) || el.points.length < min || !el.points.every(isPoint)) return fail(where, `needs "points": at least ${min} points [[x, y], ...] in canvas coordinates.`);
    }
    place(where, el.id, type, box);
  };

  steps.forEach((value, si) => {
    const at = `step ${si + 1}`;
    if (!isObject(value)) return fail(at, "a step must be an object.");
    unknownKeys(at, value, ["say", "do", "pause", "duration"]);
    const say = value.say;
    if (say !== undefined && (typeof say !== "string" || !tokens(say).length)) fail(at, `"say" must be text with at least one word.`);
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
      const id = isObject(raw.add) ? raw.add.id : isObject(raw.update) ? raw.update.id : (raw.remove ?? raw.point);
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
        for (const el of Array.isArray(raw.add) ? raw.add : [raw.add]) addElement(where, el);
      } else if (raw.update !== undefined) {
        const u = raw.update;
        if (!isObject(u)) return fail(where, `"update" must be an object with an "id".`);
        unknownKeys(where, u, ["id", "x", "y", "dx", "dy", "width", "height", "text", ...STYLE]);
        checkStyle(where, u);
        const ids = Array.isArray(u.id) ? u.id : [u.id];
        for (const key of ["x", "y", "dx", "dy", "width", "height"]) if (u[key] !== undefined && !isNumber(u[key])) fail(where, `${key} must be a number.`);
        for (const target of ids) {
          if (!checkRef(where, "id", typeof target === "string" ? target : undefined)) continue;
          const el = live.get(target as string)!;
          if (!el.box && ["x", "y", "width", "height"].some((k) => u[k] !== undefined) && !["text", "image"].includes(el.type)) {
            fail(where, `${quote(target)} is a ${el.type}; move it with dx and dy (x, y, width and height are for shapes, text and images).`);
          }
          if (u.text !== undefined && el.type !== "text") fail(where, `"text" can only replace the content of a text element; ${quote(target)} is a ${el.type}.`);
          if (el.box) {
            const b = el.box;
            el.box = {
              x: (isNumber(u.x) ? u.x : b.x) + (isNumber(u.dx) ? u.dx : 0),
              y: (isNumber(u.y) ? u.y : b.y) + (isNumber(u.dy) ? u.dy : 0),
              w: isNumber(u.width) ? u.width : b.w,
              h: isNumber(u.height) ? u.height : b.h,
            };
          }
        }
      } else if (raw.remove !== undefined) {
        const ids = Array.isArray(raw.remove) ? raw.remove : [raw.remove];
        for (const target of ids) if (checkRef(where, "remove", typeof target === "string" ? target : undefined)) live.delete(target as string);
      } else if (raw.camera !== undefined) {
        const c = raw.camera;
        if (c === "reset") return;
        if (!isObject(c)) return fail(where, `"camera" must be "reset", { x, y, width } or { fit }.`);
        if (c.fit !== undefined) {
          unknownKeys(where, c, ["fit", "padding"]);
          if (c.fit !== "all" && !(Array.isArray(c.fit) && c.fit.length)) return fail(where, `"fit" must be "all" or a list of element ids.`);
          if (Array.isArray(c.fit)) for (const target of c.fit) checkRef(where, "fit", typeof target === "string" ? target : undefined);
        } else {
          unknownKeys(where, c, ["x", "y", "width"]);
          if (!(isNumber(c.x) && isNumber(c.y) && isNumber(c.width) && c.width > 0)) fail(where, `"camera" needs numeric x, y and a positive width (the height follows from the canvas).`);
        }
      } else checkRef(where, "point", raw.point);
    });
  });

  if (!used.size) warnings.push("script: nothing is ever drawn.");
  return { errors, warnings };
}
