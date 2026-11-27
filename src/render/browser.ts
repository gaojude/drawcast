/** Finding a Chromium-family browser to render in: one that is installed, or one downloaded for the purpose. */
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Browser as BrowserName, type BrowserPlatform, detectBrowserPlatform, getInstalledBrowsers, launch } from "@puppeteer/browsers";
import puppeteer, { type Browser } from "puppeteer-core";
import { cacheDir } from "../paths.ts";

function installedBrowsers(): string[] {
  const env = process.env;
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((r) => [path.join(r, "Google/Chrome/Application/chrome.exe"), path.join(r, "Microsoft/Edge/Application/msedge.exe")]);
  }
  if (process.platform === "darwin") {
    return ["Google Chrome", "Chromium", "Microsoft Edge"].map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`);
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  return (env.PATH ?? "").split(path.delimiter).flatMap((dir) => names.map((n) => path.join(dir, n)));
}

/** Path of the browser to use; `download` allows fetching one when none is installed. */
export async function findBrowser(download: boolean, log: (line: string) => void, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const chosen = process.env.DRAWCAST_BROWSER;
  if (chosen) {
    if (!isExecutable(chosen)) throw new Error(`DRAWCAST_BROWSER points at ${chosen}, which is missing or is not an executable file.`);
    return path.resolve(chosen);
  }
  const found = installedBrowsers().find(isExecutable);
  if (found) return found;

  const platform = detectBrowserPlatform();
  if (!platform) return null;
  const dir = path.join(cacheDir(), "browser");
  const browser = BrowserName.CHROMEHEADLESSSHELL;
  const cached = (await getInstalledBrowsers({ cacheDir: dir }))
    .filter((b) => b.browser === browser && b.platform === platform && isExecutable(b.executablePath))
    .sort((a, b) => b.buildId.localeCompare(a.buildId, "en", { numeric: true }));
  signal?.throwIfAborted();
  if (cached.length) return cached[0].executablePath;
  if (!download) return null;
  log(`No Chrome, Chromium or Edge found; downloading a headless Chrome to ${dir} (once)`);
  return installBrowser(dir, platform, signal);
}

/** The installer can start a separate archive extractor. Cancel its whole process tree before cleaning up. */
async function installBrowser(dir: string, platform: BrowserPlatform, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(path.join(dir, ".install-"));
  try {
    signal?.throwIfAborted();
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@puppeteer/browsers/package.json");
    const cli = path.resolve(path.dirname(manifest), require(manifest).bin);
    const browser = BrowserName.CHROMEHEADLESSSHELL;
    const child = launch({
      executablePath: process.execPath, args: [cli, "install", `${browser}@stable`, "--platform", platform, "--path", staging],
      env: process.env, signal, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    await child.hasClosed();
    signal?.throwIfAborted();
    if (child.nodeProcess.exitCode !== 0) throw new Error(`Failed to install headless Chrome.\n${child.getRecentLogs().join("\n")}`);
    const [build] = await getInstalledBrowsers({ cacheDir: staging });
    if (!build || !isExecutable(build.executablePath)) throw new Error("The downloaded browser has no runnable executable.");
    const destination = path.join(dir, path.relative(staging, build.path));
    const executable = path.join(destination, path.relative(build.path, build.executablePath));
    await mkdir(path.dirname(destination), { recursive: true });
    signal?.throwIfAborted();
    try {
      await rename(build.path, destination);
    } catch (error) {
      // A concurrent installer may already have published the same complete build.
      if (!isExecutable(executable)) throw error;
    }
    signal?.throwIfAborted();
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 4 });
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export async function launchBrowser(log: (line: string) => void, signal?: AbortSignal): Promise<Browser> {
  const executablePath = await findBrowser(true, log, signal);
  signal?.throwIfAborted();
  if (!executablePath) throw new Error("No browser to render in. Install Chrome, Chromium or Edge, or set DRAWCAST_BROWSER to one.");
  return puppeteer.launch({
    executablePath,
    headless: true,
    ...(signal && { signal, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }),
    // The page only ever loads drawcast's own files from localhost. Containers and CI runners often
    // cannot use Chrome's sandbox, so it is off when running as root.
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
  });
}
