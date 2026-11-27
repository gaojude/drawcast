import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package: `dist/cli.js` sits one level below it. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where downloaded models, a downloaded browser and synthesized speech are kept between runs. */
export function cacheDir(): string {
  if (process.env.DRAWCAST_HOME) return path.resolve(process.env.DRAWCAST_HOME);
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "drawcast");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "drawcast");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "drawcast");
}

/**
 * Where settings are kept that clearing a cache must not lose, such as a saved API key. On Windows that
 * is the same folder as the cache, which nothing clears by itself and which does not roam to other
 * machines. DRAWCAST_HOME moves it too.
 */
export function configDir(): string {
  if (process.env.DRAWCAST_HOME || process.platform === "win32") return cacheDir();
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "drawcast");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "drawcast");
}
