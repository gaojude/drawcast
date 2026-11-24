/**
 * The page the CLI drives in a headless browser. It is handed a script and the timing of its audio, and
 * renders any moment of the result: Excalidraw draws the canvas, and the pointer and captions are painted
 * on top. One moment comes out as a PNG. A video comes out as H.264 from the browser's own encoder, which
 * takes its frames straight from the canvas.
 */
import { convertToExcalidrawElements, exportToCanvas } from "@excalidraw/excalidraw";
import { type ColorSpace, avcCodecs } from "../shared/h264.ts";
import { DEFAULT_CANVAS, type Formula, type Script, type StepAudio } from "../shared/types.ts";
import { type FormulaFile, type Frame, type ImageInfo, type Schedule, type Timeline, timeline } from "./compile.ts";
import type { Rect } from "./elements.ts";

/** Everything about a video but its timing, so the page can get ready while the narration is still being spoken. */
export interface PrepareRequest {
  script: Script;
  /** image `src` -> data URL */
  images: Record<string, string>;
  /** LaTeX -> the formula typeset from it */
  math: Record<string, Formula>;
  output: { width: number; height: number };
  /** For a video: the encoder to find and try out meanwhile. A still needs none. */
  video?: EncodeRequest;
}

export interface LoadResult {
  duration: number;
  stepStarts: number[];
  stepEnds: number[];
}

const CAPTION_FONT = 'Nunito, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Xiaolai, sans-serif';
const LASER = "#e03131";

let request: PrepareRequest;
let images: Map<string, ImageInfo>;
let files: Record<string, unknown>;
let formula: FormulaFile;
/** The script against its audio, as far as the audio has come. */
let line: Timeline;

/** A canvas that frames are painted on. It remembers what it shows, so a frame that changes nothing costs nothing. */
interface Surface {
  stage: HTMLCanvasElement;
  /** Excalidraw's picture of the elements, kept for the frames in which only the pointer or caption moves */
  board: HTMLCanvasElement | null;
  boardKey: string;
  frameKey: string;
}

function surface(): Surface {
  const stage = document.createElement("canvas");
  stage.width = request.output.width;
  stage.height = request.output.height;
  return { stage, board: null, boardKey: "", frameKey: "" };
}

/** Where `frame` paints. */
let still: Surface;

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
 * Excalidraw ends every list of fonts with "Segoe UI Emoji", for emoji on Windows. That font also answers
 * for symbols it has no real glyph for: it draws ≠ as a hyphen, ∞ and ∫ as a degree sign, √ as Ã, and ↔ as
 * an emoji. A font declared here under the same name hides the installed one, and it is the installed one
 * limited to the emoji, so any other character the drawing fonts lack goes to a font the system picks for
 * it. Where there is no such font installed this does nothing, and nothing needed doing.
 */
let emojiOnly: Promise<unknown> | undefined;
function limitEmojiFont() {
  emojiOnly ??= (async () => {
    const face = new FontFace("Segoe UI Emoji", 'local("Segoe UI Emoji")', { unicodeRange: "U+200D, U+20E3, U+2600-27BF, U+2B00-2BFF, U+FE0F, U+1F000-1FAFF, U+E0020-E007F" });
    document.fonts.add(face);
    await face.load().catch(() => {});
  })();
  return emojiOnly;
}

/**
 * Text is measured when its element is built, so its font has to be there first: measured in a fallback
 * font, a label comes out too narrow and loses its last letters. Excalidraw loads the fonts (and, for
 * Chinese, only the slices of the font) that the elements it is asked to export need.
 */
async function loadFonts(script: Script) {
  await limitEmojiFont();
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

/**
 * A formula is an image like any other, except that it comes in whatever colour it is asked for: its
 * picture is drawn in `currentColor`, and each colour of it is a file of its own.
 */
function formulaFiles(math: Record<string, Formula>): FormulaFile {
  const ids = new Map<string, string>();
  return (tex, color) => {
    const formula = math[tex];
    if (!formula) return undefined;
    const key = JSON.stringify([tex, color]);
    let fileId = ids.get(key);
    if (!fileId) {
      fileId = `math-${ids.size}`;
      ids.set(key, fileId);
      const svg = formula.svg.replace("<svg ", `<svg color="${color}" `);
      files[fileId] = { id: fileId, dataURL: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, mimeType: "image/svg+xml", created: 1 };
    }
    return { fileId, width: formula.width, height: formula.height };
  };
}

async function loadImages(sources: Record<string, string>): Promise<Map<string, ImageInfo>> {
  const out = new Map<string, ImageInfo>();
  await Promise.all(
    Object.entries(sources).map(async ([src, dataURL], i) => {
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

/**
 * Loads the script's fonts and images, and for a video starts on finding an encoder. None of it depends
 * on how long the narration turns out to be, so it is done while the narration is spoken.
 */
async function prepare(req: PrepareRequest): Promise<void> {
  stopEncoding();
  request = req;
  still = surface();
  files = {};
  // one set of formula pictures for the page: a timeline made later asks for the same ones by the same names
  formula = formulaFiles(req.math);
  encoderReady = req.video ? startEncoding(req.video).catch((e) => ({ encoder: null, tried: [String(e?.message || e)] })) : null;
  [images] = await Promise.all([loadImages(req.images), loadFonts(req.script)]);
  line = timeline(req.script, images, formula);
}

/**
 * Schedules the next steps of the script against their audio, one entry for each. Frames before the
 * `settled` it returns can be asked for from then on, so a video can be drawn as far as it has been spoken.
 */
const schedule = (audio: (StepAudio | null)[]): Schedule => line.extend(audio);

/** Forgets every step scheduled so far: the script is to be scheduled again, against other audio. */
function startOver(): void {
  line = timeline(request.script, images, formula);
  // what was painted for another timing is not this timing's picture
  for (const s of [still, ...lanes.map((lane) => lane.surface)]) s.boardKey = s.frameKey = "";
}

/** Schedules the whole script at once, from the start, against audio for every step. */
function load(audio: (StepAudio | null)[]): LoadResult {
  if (audio.length !== request.script.steps.length) throw new Error(`The script has ${request.script.steps.length} steps, and audio came for ${audio.length}.`);
  startOver();
  const { stepStarts, stepEnds, settled } = line.extend(audio);
  return { duration: settled, stepStarts, stepEnds };
}

function drawPointer(g: CanvasRenderingContext2D, p: NonNullable<Frame["pointer"]>, view: Rect) {
  const k = g.canvas.width / view.w;
  const unit = g.canvas.height / 1080;
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
  const { width: W, height: H } = g.canvas;
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

/**
 * Paints the frame at time `t` on a surface. False when the surface shows that very picture already.
 * `bare` leaves the pointer and the caption out, which is how a cover shows the canvas.
 */
async function paint(s: Surface, t: number, bare = false): Promise<boolean> {
  const at = line.frameAt(t);
  const f = bare ? { ...at, pointer: null, caption: null } : at;
  const key = JSON.stringify([f.elements, f.view]);
  const overlay = JSON.stringify([f.pointer, f.caption]);
  if (key === s.boardKey && overlay === s.frameKey) return false;
  if (key !== s.boardKey) {
    // nothing is remembered until the new board is there, in case drawing it fails
    s.boardKey = s.frameKey = "";
    s.board = await drawBoard(f.elements, f.view);
  }
  s.boardKey = key;
  s.frameKey = overlay;

  const g = s.stage.getContext("2d", { alpha: false })!;
  g.drawImage(s.board!, 0, 0);
  if (f.pointer) drawPointer(g, f.pointer, f.view);
  if (f.caption) drawCaption(g, f.caption);
  return true;
}

/** The frame at time `t` as a PNG data URL, or null when it is identical to the frame rendered before it. */
async function frame(t: number, bare = false): Promise<string | null> {
  return (await paint(still, t, bare)) ? still.stage.toDataURL("image/png") : null;
}

/** The Excalidraw elements on the canvas at time `t`, as Excalidraw itself would save them. */
const elements = (t: number): unknown[] => line.frameAt(t).elements as unknown[];

// ---------------------------------------------------------------- video

/**
 * Turning a canvas into a PNG takes several times longer than drawing it, and the PNG then has to be
 * carried out of the browser, decoded and encoded again. The browser's video encoder reads the canvas
 * where it is, so the frames never leave the page: only the finished H.264 does.
 *
 * An encoder works through its frames one at a time, and that, not the drawing, is what a video waits
 * for. So the video is cut into segments, each starting with a key frame, and several encoders (lanes)
 * each take segments, with a canvas of their own to draw on.
 */
interface Lane {
  surface: Surface;
  encoder: VideoEncoder;
  /** what the encoder has put out since the last segment was collected */
  parts: Uint8Array[];
  /** how the encoder says it stores colour, once it has said */
  color: ColorSpace | null;
  error: string | null;
  /** wakes a segment that is waiting for the encoder to catch up */
  wake: (() => void) | null;
}

export interface EncodeRequest {
  fps: number;
  /** how many encoders to run side by side */
  lanes: number;
}

export interface EncodeInfo {
  /** the encoder that was found, e.g. `avc1.640028` */
  codec: string;
  /** false for the software encoder; true for whatever the browser picks when that one will not do, most often the graphics card's */
  hardware: boolean;
  lanes: number;
  /** how it stores colour, when it says */
  color: ColorSpace | null;
}

export interface EncodeStart {
  /** the encoder the video will be made with; null when this browser has none that can be trusted */
  encoder: EncodeInfo | null;
  /** a line for each encoder that was tried, saying how it did */
  tried: string[];
}

let lanes: Lane[] = [];
let encodeFps = 30;
/** The search for an encoder that `prepare` set off. */
let encoderReady: Promise<EncodeStart> | null = null;
/** How the video stores colour: what the first encoder said of its first frame. The file is labelled with it once. */
let encodeColor: ColorSpace | null = null;

const sameColor = (a: ColorSpace, b: ColorSpace) => a.fullRange === b.fullRange && a.matrix === b.matrix && a.primaries === b.primaries && a.transfer === b.transfer;

function stopEncoding(): void {
  for (const lane of lanes) {
    if (lane.encoder.state !== "closed") lane.encoder.close();
    lane.error ??= "encoding was stopped";
    lane.wake?.();
  }
  lanes = [];
}

function openLane(config: VideoEncoderConfig): Lane {
  const lane: Lane = {
    surface: surface(),
    parts: [],
    color: null,
    error: null,
    wake: null,
    encoder: new VideoEncoder({
      output(chunk, metadata) {
        const space = metadata?.decoderConfig?.colorSpace;
        if (space) {
          lane.color = { fullRange: space.fullRange, matrix: space.matrix, primaries: space.primaries, transfer: space.transfer };
          // Chrome converts a canvas that lives on the graphics card and one that lives in memory to
          // different ranges of YUV. Part of a video stored the other way would play too dark or too pale.
          if (encodeColor && !sameColor(lane.color, encodeColor)) lane.error = "the encoder changed how it stores colour partway";
        }
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        lane.parts.push(bytes);
      },
      error(e) {
        lane.error = e.message || String(e);
        lane.wake?.();
      },
    }),
  };
  lane.encoder.addEventListener("dequeue", () => lane.wake?.());
  lane.encoder.configure(config);
  return lane;
}

/** Hands the lane's canvas to its encoder as the frame numbered `i`, once the encoder has room for it. */
async function push(lane: Lane, i: number, keyFrame: boolean): Promise<void> {
  // each waiting frame holds a copy of the picture, so the queue is kept short
  while (lane.encoder.encodeQueueSize > 2 && !lane.error) await new Promise<void>((resolve) => (lane.wake = resolve));
  lane.wake = null;
  if (lane.error) throw new Error(lane.error);
  // the stream that leaves the page carries no times; these only have to rise, and the test card is -1
  const period = 1e6 / encodeFps;
  const picture = new VideoFrame(lane.surface.stage, { timestamp: Math.round((i + 1) * period), duration: Math.round(period) });
  try {
    lane.encoder.encode(picture, { keyFrame });
  } finally {
    picture.close();
  }
}

/** Everything the lane's encoder owes: the frames pushed so far, finished. */
async function collect(lane: Lane, frames: number): Promise<Uint8Array> {
  await lane.encoder.flush();
  if (lane.error) throw new Error(lane.error);
  // one access unit per frame, or the video would run short of its sound
  if (lane.parts.length !== frames) throw new Error(`the encoder returned ${lane.parts.length} frames for ${frames}`);
  const out = new Uint8Array(lane.parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of lane.parts) {
    out.set(p, at);
    at += p.length;
  }
  lane.parts = [];
  return out;
}

const withTimeout = <T>(work: Promise<T>, seconds: number, what: string): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took more than ${seconds} s`)), seconds * 1000))]);

// An encoder is not taken at its word. Chrome's software encoder, given a canvas from the graphics card
// whose width is not a multiple of four, quietly stretches the picture by two pixels; an encoder can also
// store colours one way and say another. Nothing reports either, and both would spoil a whole video. So
// each encoder first gets a test card, which is decoded again and held against the original.

const CELL = 32;
/** Plain colours a whiteboard is drawn in. */
const SWATCHES = ["#e03131", "#2f9e44", "#1971c2", "#ffec99", "#868e96"];
/**
 * How far the decoded card may be from the original, in levels of 255, averaged over an area. Faithful
 * encoders measure 1 to 2 for shape and 2 to 6 for colour; the stretched picture measures 18, and colours
 * stored in the other range would be off by more than 15.
 */
const SHAPE_LIMIT = 6;
const COLOUR_LIMIT = 10;

interface Square {
  x: number;
  y: number;
  size: number;
}

/**
 * Paints the test card and returns where its swatches are. A lattice of dark bars reaches every edge: a
 * picture moved or stretched by a pixel puts many of them in the wrong place. The swatches are squares of
 * plain colour, which come back another colour if the encoder's account of how it stores colour is wrong.
 */
function paintTestCard(stage: HTMLCanvasElement): Square[] {
  const g = stage.getContext("2d", { alpha: false })!;
  const { width: W, height: H } = stage;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#1e1e1e";
  for (let x = 8; x < W; x += CELL) g.fillRect(x, 0, 8, H);
  for (let y = 8; y < H; y += CELL) g.fillRect(0, y, W, 8);
  const size = CELL * 2;
  const y = Math.max(0, Math.floor((H / 2 - CELL) / CELL) * CELL);
  const squares: Square[] = [];
  SWATCHES.forEach((color, i) => {
    const x = CELL + i * (size + CELL);
    if (x + size > W || y + size > H) return;
    g.fillStyle = color;
    g.fillRect(x, y, size, size);
    squares.push({ x, y, size });
  });
  return squares;
}

/** A picture's pixels, read from a copy kept in memory: reading a canvas directly moves it off the graphics card for good. */
function pixels(picture: HTMLCanvasElement | VideoFrame, width: number, height: number): Uint8ClampedArray {
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const g = copy.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(picture, 0, 0);
  return g.getImageData(0, 0, width, height).data;
}

function decodeKeyFrame(codec: string, color: ColorSpace | null, data: Uint8Array): Promise<VideoFrame> {
  return new Promise((resolve, reject) => {
    let frame: VideoFrame | null = null;
    const decoder = new VideoDecoder({ output: (f) => (frame ? f.close() : (frame = f)), error: reject });
    // decoded the way the file will say to: by the colour space the encoder reported
    decoder.configure({ codec, ...(color ? { colorSpace: color as VideoColorSpaceInit } : {}) });
    decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data }));
    decoder.flush().then(() => {
      decoder.close();
      if (frame) resolve(frame);
      else reject(new Error("it could not be decoded again"));
    }, reject);
  });
}

/**
 * How far an encoder's picture of the test card on `stage` is from the card, in levels of 255: `shape`
 * over the whole picture, `colour` inside the swatches.
 */
async function distance(stage: HTMLCanvasElement, squares: Square[], codec: string, color: ColorSpace | null, data: Uint8Array): Promise<{ shape: number; colour: number }> {
  const { width: W, height: H } = stage;
  const decoded = await decodeKeyFrame(codec, color, data);
  let b: Uint8ClampedArray;
  try {
    if (decoded.displayWidth !== W || decoded.displayHeight !== H) throw new Error(`its picture is ${decoded.displayWidth} x ${decoded.displayHeight}, not ${W} x ${H}`);
    b = pixels(decoded, W, H);
  } finally {
    decoded.close();
  }
  const a = pixels(stage, W, H);

  // shape: the worst of nine regions, since a stretched picture is right at one edge and wrong at the other
  let shape = 0;
  for (let region = 0; region < 9; region++) {
    const x0 = Math.floor((W * (region % 3)) / 3);
    const x1 = Math.floor((W * ((region % 3) + 1)) / 3);
    const y0 = Math.floor((H * Math.floor(region / 3)) / 3);
    const y1 = Math.floor((H * (Math.floor(region / 3) + 1)) / 3);
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let i = (y * W + x0) * 4, end = (y * W + x1) * 4; i < end; i += 4) {
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        n += 3;
      }
    }
    if (n) shape = Math.max(shape, sum / n);
  }

  // colour: the inside of each swatch, away from the edge that the coarser colour planes of H.264 blur
  let colour = 0;
  for (const s of squares) {
    const sums = [0, 0, 0];
    let n = 0;
    for (let y = s.y + 8; y < s.y + s.size - 8; y++) {
      for (let i = (y * W + s.x + 8) * 4, end = (y * W + s.x + s.size - 8) * 4; i < end; i += 4) {
        for (let c = 0; c < 3; c++) sums[c] += a[i + c] - b[i + c];
        n++;
      }
    }
    colour = Math.max(colour, ...sums.map((sum) => Math.abs(sum) / n));
  }
  return { shape, colour };
}

/**
 * Finds an H.264 encoder in this browser and readies it. There may be none that works, which is for the
 * caller to make up for: Chromium can be built without one.
 *
 * The software encoder is asked for first. It is the same in every Chrome, it labels its colours, and on
 * a picture that mostly stands still it is no slower than a graphics card's.
 */
async function startEncoding(o: EncodeRequest): Promise<EncodeStart> {
  const tried: string[] = [];
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") return { encoder: null, tried: ["this browser has no video encoder"] };
  const { width, height } = request.output;
  encodeFps = o.fps;
  const codecs = avcCodecs(width, height, o.fps);
  if (!codecs.length) tried.push(`H.264 has no room for ${width} x ${height} at ${o.fps} frames a second`);
  for (const hardwareAcceleration of ["prefer-software", "no-preference"] as const) {
    for (const codec of codecs) {
      const name = `${codec} (${hardwareAcceleration === "prefer-software" ? "software" : "any"})`;
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        framerate: o.fps,
        // a ceiling, about what a detailed picture in motion needs; a whiteboard uses a fraction of it
        bitrate: Math.max(2_000_000, Math.round(width * height * o.fps * 0.15)),
        // frames are never dropped to keep up
        latencyMode: "quality",
        hardwareAcceleration,
        // with the parameter sets in the stream, which is how ffmpeg reads it from a pipe
        avc: { format: "annexb" },
      };
      try {
        if (!(await VideoEncoder.isConfigSupported(config)).supported) {
          tried.push(`${name}: not there`);
          continue;
        }
        const first = openLane(config);
        lanes = [first];
        encodeColor = null;
        // The card is painted on the canvas the lane will draw its frames on, so it takes the same road
        // to the encoder as they will. Its keys are untouched, so the first real frame paints over it.
        const squares = paintTestCard(first.surface.stage);
        await push(first, -1, true);
        const card = await withTimeout(collect(first, 1), 20, "its first frame");
        const off = await withTimeout(distance(first.surface.stage, squares, codec, first.color, card), 20, "decoding its first frame");
        const measured = `picture off by ${off.shape.toFixed(1)} and colours by ${off.colour.toFixed(1)}, of 255`;
        if (off.shape > SHAPE_LIMIT) throw new Error(`its picture comes out moved or stretched (${measured})`);
        if (off.colour > COLOUR_LIMIT) throw new Error(`its colours come out wrong (${measured})`);
        tried.push(`${name}: faithful (${measured})`);
        encodeColor = first.color;
        for (let i = 1; i < o.lanes; i++) lanes.push(openLane(config));
        return { encoder: { codec, hardware: hardwareAcceleration !== "prefer-software", lanes: lanes.length, color: encodeColor }, tried };
      } catch (e) {
        tried.push(`${name}: ${(e as Error).message || e}`);
        stopEncoding();
      }
    }
  }
  return { encoder: null, tried };
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Frames `first` to `first + count - 1` as H.264 (Annex B, in base64), starting with a key frame, so that
 * segments put end to end are one stream whichever lane made them. A lane takes one segment at a time.
 * With `cover`, the first of these frames is the cover: the canvas at that time, in place of its own.
 */
async function encodeSegment(index: number, first: number, count: number, cover?: number): Promise<string> {
  const lane = lanes[index];
  if (!lane) throw new Error("encoding has not been started");
  for (let i = first; i < first + count; i++) {
    if (i === first && cover !== undefined) await paint(lane.surface, cover, true);
    else await paint(lane.surface, i / encodeFps);
    await push(lane, i, i === first);
  }
  return base64(await collect(lane, count));
}

/** The encoder `prepare` was asked to find, once the search is over. */
const encoder = (): Promise<EncodeStart> => encoderReady ?? Promise.resolve({ encoder: null, tried: ["no video was asked for"] });

const api = { prepare, load, schedule, startOver, frame, elements, encoder, encodeSegment, stopEncoding };
export type PlayerApi = typeof api;
(window as any).drawcast = api;
