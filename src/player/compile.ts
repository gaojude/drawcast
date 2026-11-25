/**
 * Script + audio timing -> a function from time to what is on the canvas.
 *
 * Every element has a track: a list of segments, each animating the element for a while and leaving it in
 * a final state. A frame is each track's latest segment evaluated at that time. Actions only ever append
 * segments, so the result is a pure function of time and any frame can be rendered on its own.
 */
import { type Action, type CameraSpec, type ColorName, DEFAULT_CANVAS, type ElementSpec, type Enter, PALETTE, type Point, type Script, type StepAudio, type TextAlign, type UpdateSpec, alignOffset } from "../shared/types.ts";
import { findPhrase, tokens } from "../shared/text.ts";
import * as E from "./elements.ts";
import type { El, Rect } from "./elements.ts";
import { type Pt, clamp, dragEase, lerp, lerpColor, minJerk, partialPolyline, polylineLength, subPath } from "./motion.ts";

/** Silence before the first step, between spoken steps, and after the last one. */
const LEAD_IN = 0.5;
const STEP_GAP = 0.35;
const TAIL = 1.0;
/** A step may start while the previous one's last stroke is finishing. */
const OVERLAP = 0.3;
/** A step is looked at this long before the next one begins, when its strokes have landed. */
const STEP_END = 0.05;
const SECONDS_PER_CHAR = 0.04;
const FADE = 0.4;
const POINTER_TRAIL = 0.22;
/** How long an element takes to travel along a path, unless told. */
const ALONG = 1.2;
/** How fast a sent dot runs along its path, in canvas units a second, and the least and most it takes. */
const SEND_SPEED = 700;
const SEND_TIME: [number, number] = [0.45, 1.6];
/** How much a pulse swells an element. */
const PULSE = 0.14;
/** Captions cover the bottom of the picture: what a camera fits is kept above them. */
const CAPTION_SHARE = 0.14;

interface Seg {
  /** the step (0-based) whose action made it */
  step?: number;
  t0: number;
  t1: number;
  /** the element once the segment is over; null = removed */
  end: El | null;
  fn?: (t: number) => El;
}

interface ViewSeg {
  step: number;
  t0: number;
  t1: number;
  from: Rect;
  to: Rect;
}

interface PointerSeg {
  step: number;
  t0: number;
  t1: number;
  at: (u: number) => Pt;
  color?: string;
}

/** What an arrow is attached to at each end, so it can follow when that element moves. */
interface Link {
  spec: ElementSpec;
  from: string | Pt;
  to: string | Pt;
}

export interface ImageInfo {
  fileId: string;
  width: number;
  height: number;
}

/** The picture of a formula in one colour, with its size in em; nothing for LaTeX the script does not use. */
export type FormulaFile = (tex: string, color: string) => ImageInfo | undefined;

export interface Pointer {
  x: number;
  y: number;
  trail: Pt[];
  alpha: number;
  color?: string;
}

export interface Frame {
  elements: El[];
  view: Rect;
  /** the laser pointer and any sent dots on their way */
  pointers: Pointer[];
  caption: string | null;
}

/** How far a timeline has got. */
export interface Schedule {
  /** When the narration of each step scheduled so far starts. */
  stepStarts: number[];
  /** When each of those steps ends: just before the next one begins, and for the last step the end of the video. */
  stepEnds: number[];
  /**
   * When everything each step does is over: its narration, and every action it started, the last of
   * which may run on into the next step. `frameAt(stepDone[i], i)` is the canvas as step i finishes.
   */
  stepDone: number[];
  /**
   * No frame before this time changes, whatever the steps still to come turn out to be: it is when the
   * next of them starts. Once the last step is in, it is the length of the video.
   */
  settled: number;
  /** How long the video is. Null until the last step is scheduled. */
  duration: number | null;
}

/**
 * A script being scheduled against its audio, a step at a time. A step's place in time depends on the
 * audio of the steps before it and on its own, never on what comes after, so the start of a video can be
 * drawn while the end of it is still being spoken.
 */
export interface Timeline {
  /** Schedules the next steps of the script, in order: `audio` has an entry for each of them. */
  extend(audio: (StepAudio | null)[]): Schedule;
  /**
   * What is on the canvas at `t`, which has to be before `settled`. With `upTo`, only what steps up to
   * that one (0-based) do is shown, and `t` may be any time once that step is scheduled.
   */
  frameAt(t: number, upTo?: number): Frame;
}

const progress = (t: number, t0: number, t1: number) => (t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 1);
const asPt = (p: Point): Pt => ({ x: p[0], y: p[1] });
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/** Cut a string at `i` UTF-16 units without splitting a surrogate pair. */
const cut = (s: string, i: number) => {
  const code = s.charCodeAt(i - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? i + 1 : i);
};

/**
 * Excalidraw wraps a label by putting line breaks into it. Maps each position in the text as typed to the
 * position in the wrapped text, so a label can be typed out and wrap the way the finished one does.
 */
function wrapMap(original: string, wrapped: string): number[] {
  const map = [0];
  let j = 0;
  for (const c of original) {
    while (j < wrapped.length && wrapped[j] === "\n" && c !== "\n" && c !== " ") j++;
    if (j < wrapped.length && (wrapped[j] === c[0] || (c === " " && wrapped[j] === "\n"))) j += c.length;
    for (let k = 0; k < c.length; k++) map.push(j);
  }
  map[map.length - 1] = wrapped.length;
  return map;
}

class Builder {
  tracks = new Map<string, Seg[]>();
  order: string[] = [];
  /** elements on the canvas after everything compiled so far */
  cur = new Map<string, El>();
  labels = new Map<string, string>();
  links = new Map<string, Link>();
  /** the formulas on the canvas, as they are now: an update can change the LaTeX and the colour */
  math = new Map<string, ElementSpec>();
  views: ViewSeg[] = [];
  pointers: PointerSeg[] = [];
  /** the step (0-based) being compiled */
  step = 0;
  /** when each element has finished being drawn in */
  drawn = new Map<string, number>();
  /** each element as it was added, to build its label again when the label changes */
  specs = new Map<string, ElementSpec>();
  /** whether captions cover the bottom of the picture */
  captions: boolean;
  view: Rect;
  canvas: Rect;
  images: Map<string, ImageInfo>;
  formula: FormulaFile;

  constructor(canvas: Rect, images: Map<string, ImageInfo>, formula: FormulaFile, captions: boolean) {
    this.canvas = this.view = canvas;
    this.captions = captions;
    this.images = images;
    this.formula = formula;
  }

  private seg(id: string, seg: Seg) {
    if (!this.tracks.has(id)) {
      this.tracks.set(id, []);
      this.order.push(id);
    }
    const index = E.fractionalIndex(this.order.indexOf(id));
    const { fn, end } = seg;
    this.tracks.get(id)!.push({ ...seg, step: this.step, end: end && { ...end, index }, fn: fn && ((t) => ({ ...fn(t), index })) });
    if (end) this.cur.set(id, { ...end, index });
    else this.cur.delete(id);
  }

  /** Runs an action starting at `t0` and returns when it is over. */
  run(a: Action, t0: number): number {
    if (a.add) {
      return list(a.add).reduce((t, spec) => {
        const end = this.add(spec, t, spec.enter ?? a.enter ?? "draw", a.duration);
        this.drawn.set(spec.id, end);
        return end;
      }, t0);
    }
    // Nothing is changed before it has been drawn: an action whose phrase is spoken while what it acts on
    // is still being drawn (or waits to be) starts once that is done, and does not get undone by the drawing.
    t0 = Math.max(t0, ...this.targets(a).map((id) => this.drawn.get(id) ?? t0));
    if (a.update) return this.update(a.update, t0, a.duration ?? (a.update.along ? ALONG : FADE));
    if (a.remove) return this.remove(list(a.remove), t0, a.duration ?? 0.3);
    if (a.camera) return this.camera(a.camera, t0, a.duration ?? 0.8);
    if (a.point) return this.point(a.point, t0, a.duration ?? 1.2);
    if (a.send) return this.send(a.send, t0, a.duration);
    if (a.pulse) return this.pulse(list(a.pulse), t0, a.duration ?? 0.6);
    return t0;
  }

  /** The ids an action other than `add` acts on, or follows. */
  private targets(a: Action): string[] {
    const ids = (v: unknown) => [v].flat().filter((x): x is string => typeof x === "string");
    if (a.update) return [...ids(a.update.id), ...ids(a.update.along)];
    if (a.remove) return ids(a.remove);
    if (a.pulse) return ids(a.pulse);
    if (a.point) return ids(a.point);
    if (a.send) return ids(typeof a.send === "object" && !Array.isArray(a.send) ? a.send.along : a.send);
    if (a.camera && typeof a.camera === "object" && "fit" in a.camera && a.camera.fit !== "all") return a.camera.fit;
    return [];
  }

  // ---------------------------------------------------------------- add

  private end(ref: string | Point | undefined): E.End | null {
    if (Array.isArray(ref)) return asPt(ref);
    return (ref !== undefined && this.cur.get(ref)) || null;
  }

  private build(spec: ElementSpec): El[] {
    switch (spec.type) {
      case "rectangle":
      case "ellipse":
      case "diamond":
        return E.makeShape(spec);
      case "text":
        return [E.makeText(spec)];
      case "math": {
        const file = this.formula(spec.tex ?? "", spec.strokeColor ?? E.DEFAULT_STROKE);
        return file ? [E.makeMath(spec, file)] : [];
      }
      case "line":
        return [E.makeLine(spec)];
      case "freedraw":
        return [E.makeFreedraw(spec)];
      case "arrow": {
        const from = this.end(spec.from);
        const to = this.end(spec.to);
        return from && to ? E.makeArrow(spec, from, to) : [];
      }
      case "image": {
        const file = this.images.get(spec.src ?? "");
        if (!file) return [];
        const width = spec.width ?? file.width;
        return [E.makeImage({ ...spec, width, height: spec.height ?? (width * file.height) / file.width }, file.fileId)];
      }
    }
  }

  private add(spec: ElementSpec, t0: number, enter: Enter, duration?: number): number {
    const [el, label] = this.build(spec);
    if (!el) return t0;
    if (spec.type === "arrow") {
      const ref = (r: string | Point) => (Array.isArray(r) ? asPt(r) : r);
      this.links.set(el.id, { spec, from: ref(spec.from!), to: ref(spec.to!) });
    }
    if (label) this.labels.set(el.id, label.id);
    if (spec.type === "math") this.math.set(el.id, spec);
    this.specs.set(el.id, spec);

    if (enter === "none" || (enter === "fade" && duration === 0)) {
      for (const e of [el, label]) if (e) this.seg(e.id, { t0, t1: t0, end: e });
      return t0;
    }
    if (enter === "fade" || spec.type === "image") {
      const t1 = t0 + (duration ?? FADE);
      for (const e of [el, label]) {
        if (e) this.seg(e.id, { t0, t1, end: e, fn: (t) => ({ ...e, opacity: e.opacity * minJerk(progress(t, t0, t1)) }) });
      }
      return t1;
    }
    if (spec.type === "math") {
      // written from left to right, about as fast as text of that width is typed
      const t1 = t0 + (duration ?? clamp((el.width / (spec.fontSize ?? 20)) * 0.07, 0.4, 2));
      this.seg(el.id, { t0, t1, end: el, fn: this.writing(el, t0, t1) });
      return t1;
    }

    // drawn: the element first, then its label typed into it
    const typed = label ?? (spec.type === "text" ? el : null);
    const typing = typed ? clamp([...typed.originalText].length * SECONDS_PER_CHAR, 0.25, 2.4) : 0;
    const drawing = typed === el ? 0 : this.strokeSeconds(el);
    const scale = duration === undefined ? 1 : duration / (drawing + typing);
    const tDrawn = t0 + drawing * scale;
    const t1 = tDrawn + typing * scale;
    if (typed !== el) this.seg(el.id, { t0, t1: tDrawn, end: el, fn: this.stroke(el, t0, tDrawn) });
    if (typed) this.seg(typed.id, { t0: tDrawn, t1, end: typed, fn: this.typing(typed, tDrawn, t1) });
    return t1;
  }

  private strokeSeconds(el: El): number {
    if (el.type === "freedraw") return clamp(polylineLength(E.absolutePoints(el)) / 600, 0.4, 2.2);
    if (el.points) return clamp(0.3 + polylineLength(E.absolutePoints(el)) / 1100, 0.35, 1.4);
    return clamp(0.3 + Math.hypot(el.width, el.height) / 1400, 0.4, 0.9);
  }

  /** The element being drawn: a shape dragged out from its corner, a path growing from its start. */
  private stroke(el: El, t0: number, t1: number): (t: number) => El {
    if (!el.points) {
      return (t) => {
        const u = dragEase(progress(t, t0, t1));
        return { ...el, width: Math.max(1, el.width * u), height: Math.max(1, el.height * u) };
      };
    }
    const pts = E.absolutePoints(el);
    const ease = el.type === "arrow" ? (u: number) => clamp(dragEase(u, 0.03), 0, 1) : minJerk;
    return (t) => ({
      ...E.withPath(el, partialPolyline(pts, ease(progress(t, t0, t1)))),
      // an arrow is attached, and a closed line filled, once the stroke arrives
      ...(el.type === "arrow" ? { endBinding: null } : {}),
      ...(el.type === "line" ? { backgroundColor: "transparent" } : {}),
    });
  }

  private typing(el: El, t0: number, t1: number): (t: number) => El {
    const original: string = el.originalText;
    const map = wrapMap(original, el.text);
    return (t) => {
      const k = Math.floor(progress(t, t0, t1) * original.length);
      return { ...el, text: cut(el.text, map[k]), originalText: cut(original, k) };
    };
  }

  /** A formula being written: its picture is uncovered from the left, the way a line of text grows. */
  private writing(el: El, t0: number, t1: number): (t: number) => El {
    return (t) => {
      const u = Math.max(progress(t, t0, t1), 0.01);
      return { ...el, width: el.width * u, crop: { ...el.crop, width: el.crop.width * u } };
    };
  }

  // ---------------------------------------------------------------- update

  /** Which point of a text or a formula its `x` is; undefined for everything placed by its left edge. */
  private align(el: El): TextAlign | undefined {
    return this.math.get(el.id)?.textAlign ?? (el.type === "text" && !el.containerId ? el.textAlign : undefined);
  }

  private update(u: UpdateSpec, t0: number, duration: number): number {
    const t1 = t0 + duration;
    const ease = (t: number) => minJerk(progress(t, t0, t1));
    /** each updated element as a function of time, for the labels and arrows that follow it */
    const moving = new Map<string, (t: number) => El>();
    /** the new label of each element whose label changes */
    const relabel = new Map<string, El>();

    for (const id of list(u.id)) {
      const base = this.cur.get(id);
      if (!base) continue;
      let target: El = { ...base };
      for (const key of E.STYLE_KEYS) if (u[key] !== undefined) target[key] = u[key];
      if (base.points) {
        target = E.translate(target, u.dx ?? 0, u.dy ?? 0);
        // an arrow that was moved by hand no longer follows its ends
        if (u.dx || u.dy) this.links.delete(id);
      } else {
        target.y = (u.y ?? base.y) + (u.dy ?? 0);
        target.width = u.width ?? base.width;
        target.height = u.height ?? base.height;
      }
      if ((u.text !== undefined || u.fontSize !== undefined) && base.type === "text" && !base.containerId) {
        const fontSize = u.fontSize ?? base.fontSize;
        const rebuilt = E.makeText({ id, type: "text", x: target.x, y: target.y, text: u.text ?? base.originalText, fontSize, fontFamily: E.fontName(base.fontFamily), textAlign: base.textAlign });
        target = { ...target, text: rebuilt.text, originalText: rebuilt.originalText, width: rebuilt.width, height: rebuilt.height, fontSize };
      }
      const formula = this.math.get(id);
      const retypeset = formula && u.tex !== undefined && u.tex !== formula.tex;
      if (formula && (retypeset || u.strokeColor !== undefined || u.fontSize !== undefined)) {
        const spec = { ...formula, tex: u.tex ?? formula.tex, strokeColor: u.strokeColor ?? formula.strokeColor, fontSize: u.fontSize ?? formula.fontSize };
        const [rebuilt] = this.build(spec);
        if (rebuilt) {
          this.math.set(id, spec);
          target = { ...target, fileId: rebuilt.fileId, crop: rebuilt.crop, width: rebuilt.width, height: rebuilt.height };
        }
      }
      if (!base.points) {
        // `x` is the point the element was placed by, which for centred text or a centred formula is its
        // middle: that point stays put when the content, and with it the width, changes
        const align = this.align(base);
        target.x = (u.x ?? base.x + alignOffset(base.width, align)) - alignOffset(target.width, align) + (u.dx ?? 0);
      }
      // travelling: the element's middle follows the path, from where it is now, to the path's end
      let route: Pt[] | null = null;
      if (u.along !== undefined && !base.points) {
        const source = typeof u.along === "string" ? this.cur.get(u.along) : null;
        const all = Array.isArray(u.along) ? u.along.map(asPt) : source?.points ? E.absolutePoints(source) : null;
        if (all && all.length > 1) {
          const path = subPath(all, ...(u.span ?? [0, 1]));
          const here = E.center(base);
          route = Math.hypot(path[0].x - here.x, path[0].y - here.y) > 1 ? [here, ...path] : path;
          const last = route[route.length - 1];
          target.x = last.x - target.width / 2;
          target.y = last.y - target.height / 2;
        }
      }
      if (u.label !== undefined) {
        const old = this.cur.get(this.labels.get(id) ?? "");
        const spec = this.specs.get(id);
        const [, rebuilt] = old && spec ? this.build({ ...spec, ...(base.points ? {} : { x: target.x, y: target.y, width: target.width, height: target.height }), label: u.label }) : [];
        if (old && rebuilt) relabel.set(id, { ...old, text: rebuilt.text, originalText: rebuilt.originalText, width: rebuilt.width, height: rebuilt.height });
      }
      const blend = (t: number): El => {
        const k = ease(t);
        const width = lerp(base.width, target.width, k);
        const height = lerp(base.height, target.height, k);
        const on = route && partialPolyline(route, k).at(-1)!;
        return {
          ...target,
          x: on ? on.x - width / 2 : lerp(base.x, target.x, k),
          y: on ? on.y - height / 2 : lerp(base.y, target.y, k),
          width,
          height,
          opacity: lerp(base.opacity, target.opacity, k),
          angle: lerp(base.angle, target.angle, k),
          strokeColor: lerpColor(base.strokeColor, target.strokeColor, k),
          backgroundColor: lerpColor(base.backgroundColor, target.backgroundColor, k),
          ...(base.type === "text" ? { fontSize: lerp(base.fontSize, target.fontSize, k) } : {}),
        };
      };
      let fn = blend;
      if (retypeset) {
        // one picture cannot turn into another, so the old formula fades out and the new one in
        fn = (t) => {
          const k = ease(t);
          const shown = k < 0.5 ? base : target;
          return { ...shown, opacity: shown.opacity * Math.abs(1 - 2 * k) };
        };
      } else if (formula && target.fileId !== base.fileId) {
        // a formula's colour is in its picture: on the way from one colour to the other, each shade is a picture
        fn = (t) => {
          const el = blend(t);
          return { ...el, fileId: this.formula(formula.tex ?? "", el.strokeColor)?.fileId ?? el.fileId };
        };
      }
      moving.set(id, fn);
      this.seg(id, { t0, t1, end: target, fn });
    }

    const follow = (id: string, fn: (t: number) => El) => this.seg(id, { t0, t1, end: fn(t1), fn });
    for (const [id, fn] of moving) {
      const label = this.cur.get(this.labels.get(id) ?? "");
      if (!label) continue;
      // a label keeps its place in the middle of its shape (or, on an arrow, of its path)
      const middle = (el: El) => (el.points ? E.pathMiddle(el) : E.center(el));
      const next = relabel.get(id);
      // a label is drawn in its shape's stroke colour, and changes colour with it
      const color = (t: number) => (u.strokeColor !== undefined ? { strokeColor: lerpColor(label.strokeColor, u.strokeColor, ease(t)) } : {});
      follow(label.id, (t) => {
        const el = fn(t);
        if (!next) return { ...E.centerOn(label, middle(el)), opacity: el.opacity, ...color(t) };
        // the old words fade out and the new ones in
        const k = ease(t);
        return { ...E.centerOn(k < 0.5 ? label : next, middle(el)), opacity: el.opacity * Math.abs(1 - 2 * k), ...color(t) };
      });
    }
    for (const [id, link] of this.links) {
      if (!this.cur.has(id)) continue;
      if (![link.from, link.to].some((end) => typeof end === "string" && moving.has(end))) continue;
      const base = this.cur.get(id)!;
      // Each end as it is now: a point, an element that stays put, or one on the move. Looked up here and
      // not when a frame is drawn, by which time later steps may have moved or removed the element.
      const [fromEnd, toEnd] = [link.from, link.to].map((end) => (typeof end !== "string" ? end : (moving.get(end) ?? this.cur.get(end))));
      const endAt = (end: Pt | El | ((t: number) => El) | undefined, t: number) => (typeof end === "function" ? end(t) : end);
      const via = (link.spec.via ?? []).map(asPt);
      const arrowAt = (t: number): El => {
        const from = endAt(fromEnd, t);
        const to = endAt(toEnd, t);
        return from && to ? E.withPath(base, E.arrowCourse(from, to, via, link.spec.rounded)) : base;
      };
      const label = this.cur.get(this.labels.get(id) ?? "");
      follow(id, arrowAt);
      if (label) follow(label.id, (t) => E.centerOn(label, E.pathMiddle(arrowAt(t))));
    }
    return t1;
  }

  // ---------------------------------------------------------------- remove

  private remove(ids: string[], t0: number, duration: number): number {
    const t1 = t0 + duration;
    const gone = ids.flatMap((id) => [id, this.labels.get(id) ?? ""]).filter((id) => this.cur.has(id));
    for (const id of gone) {
      const el = this.cur.get(id)!;
      this.seg(id, { t0, t1, end: null, fn: (t) => ({ ...el, opacity: el.opacity * (1 - minJerk(progress(t, t0, t1))) }) });
      this.links.delete(id);
      this.labels.delete(id);
      this.math.delete(id);
    }
    // an arrow that pointed at something removed stays where it is, attached to nothing
    for (const [id, link] of this.links) {
      const arrow = this.cur.get(id);
      if (!arrow) continue;
      const pts = E.absolutePoints(arrow);
      if (typeof link.from === "string" && gone.includes(link.from)) link.from = pts[0];
      if (typeof link.to === "string" && gone.includes(link.to)) link.to = pts[pts.length - 1];
    }
    return t1;
  }

  // ---------------------------------------------------------------- camera and pointer

  private bounds(ids: string[]): Rect | null {
    const boxes = ids.flatMap((id) => [id, this.labels.get(id) ?? ""]).map((id) => this.cur.get(id)).filter((el): el is El => !!el).map(E.bbox);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
  }

  private camera(spec: CameraSpec, t0: number, duration: number): number {
    const aspect = this.canvas.w / this.canvas.h;
    let to: Rect;
    if (spec === "reset") to = this.canvas;
    else if ("fit" in spec) {
      const b = this.bounds(spec.fit === "all" ? [...this.cur.keys()] : spec.fit);
      if (!b) return t0;
      const pad = spec.padding ?? 80;
      // the part of the picture above the captions is what has to hold it
      const clear = this.captions ? 1 - CAPTION_SHARE : 1;
      const w = Math.max(b.w + pad * 2, ((b.h + pad * 2) * aspect) / clear);
      const h = w / aspect;
      to = { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - (h * clear) / 2, w, h };
    } else to = { x: spec.x, y: spec.y, w: spec.width, h: spec.width / aspect };
    this.views.push({ step: this.step, t0, t1: t0 + duration, from: this.view, to });
    this.view = to;
    return t0 + duration;
  }

  /** A dot runs along each path, all of them at once: a message on its way. */
  private send(spec: NonNullable<Action["send"]>, t0: number, duration?: number): number {
    const { along, color, reverse } = typeof spec === "object" && !Array.isArray(spec) ? spec : { along: spec, color: undefined, reverse: false };
    const hex = color && color in PALETTE ? PALETTE[color as ColorName][0] : color;
    let end = t0;
    for (const id of list(along)) {
      const el = this.cur.get(id);
      if (!el?.points) continue;
      const pts = reverse ? E.absolutePoints(el).reverse() : E.absolutePoints(el);
      const t1 = t0 + (duration ?? clamp(polylineLength(pts) / SEND_SPEED, ...SEND_TIME));
      // eased gently at both ends, so the dot sets off and arrives rather than blinking in and out
      const ease = (u: number) => 0.15 * minJerk(u) + 0.85 * u;
      this.pointers.push({ step: this.step, t0, t1, color: hex, at: (u) => partialPolyline(pts, ease(u)).at(-1)! });
      end = Math.max(end, t1);
    }
    return end;
  }

  /** Elements swell and settle back. A path's stroke thickens instead. */
  private pulse(ids: string[], t0: number, duration: number): number {
    const t1 = t0 + duration;
    const swell = (t: number) => Math.sin(Math.PI * progress(t, t0, t1)) ** 2;
    for (const id of ids.flatMap((id) => [id, this.labels.get(id) ?? ""])) {
      const el = this.cur.get(id);
      if (!el) continue;
      const fn = (t: number): El => {
        const k = 1 + PULSE * swell(t);
        if (el.points) return { ...el, strokeWidth: el.strokeWidth * (1 + 1.5 * swell(t)) };
        const c = E.center(el);
        const w = el.width * k;
        const h = el.height * k;
        return { ...el, x: c.x - w / 2, y: c.y - h / 2, width: w, height: h, ...(el.type === "text" ? { fontSize: el.fontSize * k } : {}) };
      };
      this.seg(id, { t0, t1, end: el, fn });
    }
    return t1;
  }

  /** The laser pointer loops around its target one and a half times. */
  private point(target: string | Point, t0: number, duration: number): number {
    const b = Array.isArray(target) ? { x: target[0], y: target[1], w: 0, h: 0 } : this.bounds([target]);
    if (!b) return t0;
    const rx = clamp(b.w * 0.3, 14, 80);
    const ry = clamp(b.h * 0.3, 10, 44);
    const phase = -Math.PI * 0.75;
    this.pointers.push({
      step: this.step,
      t0,
      t1: t0 + duration,
      at: (u) => {
        const th = phase + minJerk(u) * Math.PI * 3;
        return { x: b.x + b.w / 2 + rx * Math.cos(th), y: b.y + b.h / 2 + ry * Math.sin(th) };
      },
    });
    return t0 + duration;
  }
}

/** When `at` is spoken: the time of the first token of the phrase, searched from `from` onwards. */
function spokenAt(at: string, audio: StepAudio, from: number): { t: number; index: number } | null {
  const said = audio.tokens.map((w) => w.token);
  const phrase = tokens(at);
  const index = findPhrase(phrase, said, from);
  const found = index >= 0 ? index : findPhrase(phrase, said);
  return found >= 0 ? { t: audio.tokens[found].t, index: found } : null;
}

export function timeline(script: Script, images: Map<string, ImageInfo>, formula: FormulaFile): Timeline {
  const size = { ...DEFAULT_CANVAS, ...script.canvas };
  const canvas: Rect = { x: 0, y: 0, w: size.width, h: size.height };
  const b = new Builder(canvas, images, formula, script.captions !== false && script.steps.some((s) => !!s.say?.trim()));
  const stepStarts: number[] = [];
  const stepEnds: number[] = [];
  const stepDone: number[] = [];
  const captions: { t0: number; t1: number; text: string }[] = [];
  let free = LEAD_IN; // when the next step may start speaking
  let busy = 0; // when the last animation ends
  let tracks: Seg[][] = [];

  const extend = (audio: (StepAudio | null)[]): Schedule => {
    if (stepStarts.length + audio.length > script.steps.length) throw new Error(`The script has ${script.steps.length} steps, and audio came for more.`);
    for (const voice of audio) {
      const step = script.steps[stepStarts.length];
      const start = Math.max(free, busy - OVERLAP);
      b.step = stepStarts.length;
      stepStarts.push(start);
      let done = start;
      for (const c of voice?.captions ?? []) captions.push({ t0: start + c.t0, t1: start + c.t1, text: c.text });

      let next = start; // where an action without `at` starts
      let from = 0;
      for (const action of step.do ?? []) {
        let t0 = next;
        if (typeof action.at === "number") t0 = start + action.at;
        else if (typeof action.at === "string" && voice) {
          const hit = spokenAt(action.at, voice, from);
          if (hit) {
            t0 = start + hit.t;
            from = hit.index;
          }
        }
        next = b.run(action, t0);
        busy = Math.max(busy, next);
        done = Math.max(done, next + (action.point !== undefined || action.send !== undefined ? POINTER_TRAIL : 0));
      }
      const length = voice?.duration ?? step.duration ?? 0;
      stepDone.push(Math.max(done, start + length));
      free = (voice ? start + length + STEP_GAP : Math.max(start + length, next)) + (step.pause ?? 0);
      stepEnds.push(Math.max(free, busy - OVERLAP) - STEP_END);
    }
    tracks = b.order.map((id) => b.tracks.get(id)!.sort((x, y) => x.t0 - y.t0));
    const duration = stepStarts.length === script.steps.length ? Math.max(free, busy) + TAIL : null;
    if (duration !== null) stepEnds[stepEnds.length - 1] = duration;
    // Nothing a step does comes before its own start, and the next one starts here.
    return { stepStarts: [...stepStarts], stepEnds: [...stepEnds], stepDone: [...stepDone], settled: duration ?? Math.max(free, busy - OVERLAP), duration };
  };

  const viewAt = (t: number, upTo: number): Rect => {
    let v: ViewSeg | null = null;
    for (const s of b.views) if (s.t0 <= t && s.step <= upTo) v = s;
    if (!v) return canvas;
    const k = minJerk(progress(t, v.t0, v.t1));
    return { x: lerp(v.from.x, v.to.x, k), y: lerp(v.from.y, v.to.y, k), w: lerp(v.from.w, v.to.w, k), h: lerp(v.from.h, v.to.h, k) };
  };

  const pointersAt = (t: number, upTo: number): Pointer[] =>
    b.pointers
      .filter((p) => p.step <= upTo && t >= p.t0 && t <= p.t1 + POINTER_TRAIL)
      .map((s) => {
        const span = s.t1 - s.t0;
        const u = (time: number) => clamp((time - s.t0) / span, 0, 1);
        const trail: Pt[] = [];
        for (let k = 8; k >= 1; k--) {
          const earlier = t - (k / 8) * POINTER_TRAIL;
          if (earlier >= s.t0) trail.push(s.at(u(earlier)));
        }
        const alpha = clamp(Math.min((t - s.t0) / 0.12, (s.t1 + POINTER_TRAIL - t) / POINTER_TRAIL), 0, 1);
        return { ...s.at(u(t)), trail, alpha, color: s.color };
      });

  const frameAt = (t: number, upTo = Infinity): Frame => {
    const els: El[] = [];
    for (const segs of tracks) {
      let seg: Seg | null = null;
      for (const s of segs) {
        if (s.t0 > t) break;
        if ((s.step ?? 0) <= upTo) seg = s;
      }
      const el = seg && (t < seg.t1 && seg.fn ? seg.fn(t) : seg.end);
      if (el) els.push(el);
    }
    const lastCaption = upTo === Infinity ? Infinity : (stepEnds[upTo] ?? Infinity);
    return {
      elements: E.withBindings(els),
      view: viewAt(t, upTo),
      pointers: pointersAt(t, upTo),
      caption: captions.find((c) => t >= c.t0 && t < c.t1 && c.t0 < lastCaption)?.text ?? null,
    };
  };

  return { extend, frameAt };
}
