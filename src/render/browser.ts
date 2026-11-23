/** Finding a Chromium-family browser to render in: one that is installed, or one downloaded for the purpose. */
import { existsSync } from "node:fs";
import path from "node:path";
import { Browser as BrowserName, computeExecutablePath, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";
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
export async function findBrowser(download: boolean, log: (line: string) => void): Promise<string | null> {
  const chosen = process.env.DRAWCAST_BROWSER;
  if (chosen) {
    if (!existsSync(chosen)) throw new Error(`DRAWCAST_BROWSER points at ${chosen}, which does not exist.`);
    return chosen;
  }
  const found = installedBrowsers().find((p) => existsSync(p));
  if (found) return found;

  const platform = detectBrowserPlatform();
  if (!platform) return null;
  const dir = path.join(cacheDir(), "browser");
  const buildId = await resolveBuildId(BrowserName.CHROMEHEADLESSSHELL, platform, "stable");
  const executable = computeExecutablePath({ browser: BrowserName.CHROMEHEADLESSSHELL, buildId, cacheDir: dir });
  if (existsSync(executable)) return executable;
  if (!download) return null;
  log(`No Chrome, Chromium or Edge found; downloading a headless Chrome to ${dir} (once)`);
  await install({ browser: BrowserName.CHROMEHEADLESSSHELL, buildId, cacheDir: dir });
  return executable;
}

export async function launchBrowser(log: (line: string) => void): Promise<Browser> {
  const executablePath = await findBrowser(true, log);
  if (!executablePath) throw new Error("No browser to render in. Install Chrome, Chromium or Edge, or set DRAWCAST_BROWSER to one.");
  return puppeteer.launch({
    executablePath,
    headless: true,
    // The page only ever loads drawcast's own files from localhost. Containers and CI runners often
    // cannot use Chrome's sandbox, so it is off when running as root.
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
  });
}
