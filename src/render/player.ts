/** Runs the player page (dist/player) in a headless browser and asks it for frames. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { packageRoot } from "../paths.ts";
import type { Schedule } from "../player/compile.ts";
import type { EncodeStart, LoadResult, PlayerApi, PrepareRequest } from "../player/main.ts";
import type { StepAudio } from "../shared/types.ts";
import { launchBrowser } from "./browser.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serves the player's files. Fonts and module scripts do not load from file:// URLs. */
async function servePlayer(): Promise<{ url: string; close: () => void }> {
  const root = path.join(packageRoot, "dist", "player");
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const file = path.join(root, name === "/" ? "index.html" : name);
    try {
      if (!file.startsWith(root)) throw new Error("outside the player folder");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

export interface Player {
  /** Schedules the whole script against its audio (one entry per step). Frames can be asked for after this. */
  load(audio: (StepAudio | null)[]): Promise<LoadResult>;
  /**
   * Schedules the next steps of the script, as their audio becomes known (one entry per step). Frames
   * before the `settled` it returns can be asked for after this, while later steps are still unknown.
   */
  schedule(audio: (StepAudio | null)[]): Promise<Schedule>;
  /** PNG of the frame at `t`, or null when it equals the one before. */
  frame(t: number): Promise<Buffer | null>;
  /** The Excalidraw elements on the canvas at `t`. */
  elements(t: number): Promise<unknown[]>;
  /**
   * The browser's own H.264 encoder, if it has one whose pictures come out right. The search for it
   * starts when the page opens, for a request with `video` in it, and this waits for its end.
   */
  encoder(): Promise<EncodeStart>;
  /**
   * Frames `first` to `first + count - 1` as an H.264 stream that starts with a key frame, made by the
   * encoder numbered `lane`. Each lane makes one segment at a time; different lanes work side by side.
   */
  encodeSegment(lane: number, first: number, count: number): Promise<Buffer>;
  stopEncoding(): Promise<void>;
  close(): Promise<void>;
}

declare const drawcast: PlayerApi;

/** Opens the page and loads the script's fonts and images into it, which needs no timing yet. With `video` in the request, the page also starts looking for its encoder. */
export async function openPlayer(request: PrepareRequest, log: (line: string) => void): Promise<Player> {
  const server = await servePlayer();
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let closed: Promise<void> | undefined;
  // closing twice is closing once: whoever is done with the page first may close it
  const close = () =>
    (closed ??= (async () => {
      server.close();
      await browser?.close();
    })());
  try {
    browser = await launchBrowser(log);
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(server.url);
    await page.waitForFunction("typeof drawcast === 'object'", { timeout: 60_000 }).catch(() => {
      throw new Error(`The player page did not start.${problems.length ? `\n${problems.join("\n")}` : ""}`);
    });
    await page.evaluate((req) => drawcast.prepare(req), request as any);
    return {
      close,
      load: (audio) => page.evaluate((a) => drawcast.load(a), audio as any),
      schedule: (audio) => page.evaluate((a) => drawcast.schedule(a), audio as any),
      async frame(t) {
        const url = await page.evaluate((time) => drawcast.frame(time), t);
        return url ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64") : null;
      },
      elements: (t) => page.evaluate((time) => drawcast.elements(time), t),
      encoder: () => page.evaluate(() => drawcast.encoder()),
      async encodeSegment(lane, first, count) {
        return Buffer.from(await page.evaluate((l, f, c) => drawcast.encodeSegment(l, f, c), lane, first, count), "base64");
      },
      stopEncoding: () => page.evaluate(() => drawcast.stopEncoding()),
    };
  } catch (e) {
    await close();
    throw e;
  }
}
