/** Runs the player page (dist/player) in a headless browser and asks it for frames. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { packageRoot } from "../paths.ts";
import type { LoadRequest, LoadResult, PlayerApi } from "../player/main.ts";
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
  info: LoadResult;
  /** PNG of the frame at `t`, or null when it equals the one before. */
  frame(t: number): Promise<Buffer | null>;
  /** The Excalidraw elements on the canvas at `t`. */
  elements(t: number): Promise<unknown[]>;
  close(): Promise<void>;
}

declare const drawcast: PlayerApi;

export async function openPlayer(request: LoadRequest, log: (line: string) => void): Promise<Player> {
  const server = await servePlayer();
  const browser = await launchBrowser(log);
  const close = async () => {
    server.close();
    await browser.close();
  };
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(server.url);
    await page.waitForFunction("typeof drawcast === 'object'", { timeout: 60_000 }).catch(() => {
      throw new Error(`The player page did not start.${problems.length ? `\n${problems.join("\n")}` : ""}`);
    });
    const info = await page.evaluate((req) => drawcast.load(req), request as any);
    return {
      info,
      close,
      async frame(t) {
        const url = await page.evaluate((time) => drawcast.frame(time), t);
        return url ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64") : null;
      },
      elements: (t) => page.evaluate((time) => drawcast.elements(time), t),
    };
  } catch (e) {
    await close();
    throw e;
  }
}
