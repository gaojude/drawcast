// Builds dist/: the CLI (Node) and the player page with Excalidraw and its fonts (browser).
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "player"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile: path.join(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  entryPoints: [path.join(root, "src/player/main.ts")],
  outdir: path.join(dist, "player"),
  bundle: true,
  splitting: true,
  format: "esm",
  target: "chrome120",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  loader: { ".woff2": "file" },
  logLevel: "warning",
});

// Excalidraw fetches its fonts at run time from EXCALIDRAW_ASSET_PATH; serve them from the page's own folder.
// Only the families a script can ask for: handwriting (with Xiaolai for Chinese), Nunito, and Cascadia.
const fonts = path.join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
for (const family of ["Excalifont", "Xiaolai", "Nunito", "Cascadia"]) {
  await cp(path.join(fonts, family), path.join(dist, "player/fonts", family), { recursive: true });
}

await writeFile(
  path.join(dist, "player/index.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>drawcast</title>
<script>window.EXCALIDRAW_ASSET_PATH = "/";</script>
<script type="module" src="/main.js"></script>
`,
);
