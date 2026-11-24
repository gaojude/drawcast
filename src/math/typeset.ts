/**
 * LaTeX to a picture. MathJax typesets a formula as an SVG that draws every glyph as a path, so it needs no
 * fonts and can sit on the canvas as an image. This runs in Node and not in the player: the checker has to
 * know a formula's size to judge the layout, and what it measures here is exactly what gets drawn.
 */
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/svg.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/bbox/BboxConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/js/input/tex/enclose/EncloseConfiguration.js";
import "@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js";
import "@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import "@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { MATH_PIXELS_PER_EM, type Formula } from "../shared/types.ts";

/**
 * What LaTeX is understood: the core, the AMS symbols and environments, and a few small packages. An
 * undefined command is an error rather than red text in the video, so `noundefined` is left out; so are the
 * packages that load code on demand, which cannot be done while typesetting in one go.
 */
const PACKAGES = ["base", "ams", "newcommand", "boldsymbol", "braket", "cancel", "cases", "color", "enclose", "gensymb", "mathtools", "textmacros", "upgreek", "bbox"];

/** MathJax's SVG is drawn in units of a thousandth of an em. */
const UNITS_PER_EM = 1000;

let convert: ((tex: string) => Formula) | undefined;

function start(): (tex: string) => Formula {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const input = new TeX({
    packages: PACKAGES,
    formatError: (_jax: unknown, error: Error) => {
      throw error;
    },
  });
  // The TeX font has all of its glyphs in the program. MathJax's default font fetches the rarer ones when
  // they are first used, which would make typesetting a formula something to wait for.
  const output = new SVG({ fontData: MathJaxTexFont, fontCache: "local" });
  const document = mathjax.document("", { InputJax: input, OutputJax: output });

  return (tex) => {
    const svg = adaptor.firstChild(document.convert(tex, { display: true })) as LiteElement;
    const box = (adaptor.getAttribute(svg, "viewBox") ?? "").split(" ").map(Number);
    // an equation number is set against the right edge of a page, and a formula here has no page
    if (box.length !== 4 || !box.every(Number.isFinite)) throw new Error("it has no size of its own (\\tag and equation numbers are not supported)");
    const width = box[2] / UNITS_PER_EM;
    const height = box[3] / UNITS_PER_EM;
    if (width < 0.05 || height < 0.05) throw new Error("it draws nothing");
    // As an image the picture needs a size in whole pixels. Rounding changes its proportions by a hair,
    // so it is told to fill that size rather than to keep them.
    adaptor.removeAttribute(svg, "style");
    adaptor.setAttribute(svg, "width", String(Math.round(width * MATH_PIXELS_PER_EM)));
    adaptor.setAttribute(svg, "height", String(Math.round(height * MATH_PIXELS_PER_EM)));
    adaptor.setAttribute(svg, "preserveAspectRatio", "none");
    return { svg: adaptor.outerHTML(svg), width, height };
  };
}

/** `$...$`, `$$...$$`, `\(...\)` and `\[...\]` around a formula say that it is one, which is already known. */
function bare(tex: string): string {
  const t = tex.trim();
  for (const [open, close] of [["$$", "$$"], ["$", "$"], ["\\(", "\\)"], ["\\[", "\\]"]]) {
    if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, -close.length);
      if (!inner.includes("$")) return inner.trim();
    }
  }
  return t;
}

const done = new Map<string, Formula | Error>();

/**
 * Typesets a formula. Throws an Error whose message says what is wrong with the LaTeX ("Undefined control
 * sequence \foo", "Missing close brace"), worded to follow "the formula could not be typeset: ".
 */
export function typeset(tex: string): Formula {
  let result = done.get(tex);
  if (!result) {
    try {
      result = (convert ??= start())(bare(tex));
    } catch (e) {
      // MathJax throws an object of its own for a mistake in the LaTeX, with the reason in `message`
      const message = (e as { message?: unknown } | null)?.message;
      result = new Error(typeof message === "string" ? message : String(e));
    }
    done.set(tex, result);
  }
  if (result instanceof Error) throw result;
  return result;
}
