// Builds dist/: the CLI (Node) and the player page with Excalidraw and its fonts (browser).
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const { dependencies } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "player"), { recursive: true });

// MathJax's SVG output imports its default font even when it is given another. That font is large and
// loads glyphs on demand; point the import at the TeX font, which src/math/typeset.ts uses anyway.
const oneMathFont = {
  name: "one-math-font",
  setup(b) {
    b.onResolve({ filter: /^#default-font\// }, (args) =>
      b.resolve(args.path.replace("#default-font/", "@mathjax/mathjax-tex-font/mjs/"), { kind: args.kind, resolveDir: root }),
    );
  },
};

await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile: path.join(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  // What npm installs next to the command stays outside it. MathJax is a devDependency and goes in: it
  // is imported on demand (see src/format/check.ts), so a script without formulas never runs it.
  external: Object.keys(dependencies),
  plugins: [oneMathFont],
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
