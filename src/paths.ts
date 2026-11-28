import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package: `dist/cli.js` sits one level below it. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the downloaded browser is kept between runs. */
export function cacheDir(): string {
  if (process.env.DRAWCAST_HOME) return path.resolve(process.env.DRAWCAST_HOME);
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "drawcast");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "drawcast");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "drawcast");
}
