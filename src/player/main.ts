/**
 * The page the CLI drives in a headless browser. It is handed a script and the timing of its audio, and
 * renders any moment of the result as a PNG: Excalidraw draws the canvas, and the pointer and captions
 * are painted on top.
 */
import { convertToExcalidrawElements, exportToCanvas } from "@excalidraw/excalidraw";
import { DEFAULT_CANVAS, type Script, type StepAudio } from "../shared/types.ts";
import { type Compiled, type Frame, type ImageInfo, compile } from "./compile.ts";
import type { Rect } from "./elements.ts";

export interface LoadRequest {
  script: Script;
  audio: (StepAudio | null)[];
  /** image `src` -> data URL */
  images: Record<string, string>;
  output: { width: number; height: number };
}

export interface LoadResult {
  duration: number;
  stepStarts: number[];
}

const CAPTION_FONT = 'Nunito, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Xiaolai, sans-serif';
const LASER = "#e03131";

let compiled: Compiled;
let request: LoadRequest;
let files: Record<string, unknown>;
let stage: HTMLCanvasElement;
let board: HTMLCanvasElement | null = null;
let boardKey = "";
let frameKey = "";

/** Excalidraw exports exactly the rectangle of a frame element; this one stands for the camera. */
const cameraFrame = (view: Rect) => ({
  id: "drawcast-camera",
  type: "frame",
  x: view.x,
  y: view.y,
  width: view.w,
  height: view.h,
  angle: 0,
  name: null,
  strokeColor: "#000000",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  index: null,
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});

const drawBoard = (elements: readonly unknown[], view: Rect) =>
  exportToCanvas({
    elements: elements as any,
    appState: { exportBackground: true, viewBackgroundColor: request.script.canvas?.background ?? DEFAULT_CANVAS.background },
    files: files as any,
    exportingFrame: cameraFrame(view) as any,
    getDimensions: () => ({ ...request.output, scale: request.output.width / view.w }),
  });

/**
 * Text is measured when its element is built, so its font has to be there first: measured in a fallback
 * font, a label comes out too narrow and loses its last letters. Excalidraw loads the fonts (and, for
 * Chinese, only the slices of the font) that the elements it is asked to export need.
 */
async function loadFonts(script: Script) {
  const specs = script.steps.flatMap((s) => s.do ?? []).flatMap((a) => (a.add ? [a.add].flat() : []));
  const texts = [
    ...specs.filter((s) => s.label || s.text).map((s) => ({ text: `${s.label ?? ""}${s.text ?? ""}`, fontFamily: { hand: 5, normal: 6, code: 3 }[s.fontFamily ?? "hand"] })),
    ...script.steps.flatMap((s) => (s.do ?? []).map((a) => a.update?.text ?? "")).map((text) => ({ text, fontFamily: 5 })),
  ].filter((t) => t.text);
  if (texts.length) {
    const probes = convertToExcalidrawElements(texts.map((t, i) => ({ type: "text", x: 0, y: i * 40, ...t })) as any);
    await exportToCanvas({ elements: probes, files: null, getDimensions: () => ({ width: 8, height: 8, scale: 1 }) });
  }
  const said = script.steps.map((s) => s.say ?? "").join("") || "A";
  await document.fonts.load(`500 24px ${CAPTION_FONT}`, said).catch(() => []);
}

async function loadImages(images: Record<string, string>): Promise<Map<string, ImageInfo>> {
  const out = new Map<string, ImageInfo>();
  files = {};
  await Promise.all(
    Object.entries(images).map(async ([src, dataURL], i) => {
      const img = new Image();
      img.src = dataURL;
      await img.decode();
      const fileId = `image-${i}`;
      files[fileId] = { id: fileId, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")), created: 1 };
      out.set(src, { fileId, width: img.naturalWidth, height: img.naturalHeight });
    }),
  );
  return out;
}

async function load(req: LoadRequest): Promise<LoadResult> {
  request = req;
  board = null;
  boardKey = frameKey = "";
  stage = document.createElement("canvas");
  stage.width = req.output.width;
  stage.height = req.output.height;
  const [images] = await Promise.all([loadImages(req.images), loadFonts(req.script)]);
  compiled = compile(req.script, req.audio, images);
  return { duration: compiled.duration, stepStarts: compiled.stepStarts };
}

function drawPointer(g: CanvasRenderingContext2D, p: NonNullable<Frame["pointer"]>, view: Rect) {
  const k = stage.width / view.w;
  const unit = stage.height / 1080;
  const screen = (q: { x: number; y: number }) => ({ x: (q.x - view.x) * k, y: (q.y - view.y) * k });
  const pts = [...p.trail, p].map(screen);
  g.save();
  g.lineCap = "round";
  g.strokeStyle = LASER;
  for (let i = 1; i < pts.length; i++) {
    g.globalAlpha = p.alpha * 0.6 * (i / pts.length);
    g.lineWidth = unit * (2 + (5 * i) / pts.length);
    g.beginPath();
    g.moveTo(pts[i - 1].x, pts[i - 1].y);
    g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
  }
  const head = pts[pts.length - 1];
  g.globalAlpha = p.alpha;
  g.shadowColor = LASER;
  g.shadowBlur = unit * 14;
  g.fillStyle = LASER;
  g.beginPath();
  g.arc(head.x, head.y, unit * 6, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawCaption(g: CanvasRenderingContext2D, text: string) {
  const { width: W, height: H } = stage;
  const size = Math.round(H / 38);
  const lineHeight = Math.round(size * 1.4);
  g.save();
  g.font = `500 ${size}px ${CAPTION_FONT}`;
  g.textBaseline = "middle";

  // break between words, or anywhere in Chinese
  const pieces = text.match(/[　-〿㐀-鿿＀-￯]|[^\s　-〿㐀-鿿＀-￯]+\s*/g) ?? [text];
  const rows: string[] = [""];
  for (const piece of pieces) {
    const row = rows[rows.length - 1];
    if (row && g.measureText((row + piece).trimEnd()).width > W * 0.7) rows.push(piece);
    else rows[rows.length - 1] = row + piece;
  }
  const widths = rows.map((r) => g.measureText(r.trimEnd()).width);
  const boxW = Math.max(...widths) + size * 1.6;
  const boxH = rows.length * lineHeight + size * 0.8;
  const boxY = H - size - boxH;
  g.fillStyle = "rgba(20, 20, 24, 0.82)";
  g.beginPath();
  g.roundRect((W - boxW) / 2, boxY, boxW, boxH, size * 0.5);
  g.fill();
  g.fillStyle = "#ffffff";
  rows.forEach((row, i) => g.fillText(row.trimEnd(), (W - widths[i]) / 2, boxY + size * 0.4 + lineHeight * (i + 0.5)));
  g.restore();
}

/** The frame at time `t` as a PNG data URL, or null when it is identical to the frame rendered before it. */
async function frame(t: number): Promise<string | null> {
  const f = compiled.frameAt(t);
  const key = JSON.stringify([f.elements, f.view]);
  const overlay = JSON.stringify([f.pointer, f.caption]);
  if (key === boardKey && overlay === frameKey) return null;
  const picture = key === boardKey && board ? board : await drawBoard(f.elements, f.view);
  board = picture;
  boardKey = key;
  frameKey = overlay;

  const g = stage.getContext("2d", { alpha: false })!;
  g.drawImage(picture, 0, 0);
  if (f.pointer) drawPointer(g, f.pointer, f.view);
  if (f.caption) drawCaption(g, f.caption);
  return stage.toDataURL("image/png");
}

/** The Excalidraw elements on the canvas at time `t`, as Excalidraw itself would save them. */
const elements = (t: number): unknown[] => compiled.frameAt(t).elements as unknown[];

const api = { load, frame, elements };
export type PlayerApi = typeof api;
(window as any).drawcast = api;
