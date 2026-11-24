import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { typeset } from "../src/math/typeset.ts";

test("a formula becomes a picture with a size in em", () => {
  const { svg, width, height } = typeset("\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}");
  assert.ok(Math.abs(width - 7.43) < 0.05, `width ${width}`);
  assert.ok(Math.abs(height - 2.76) < 0.05, `height ${height}`);
  // an image must say how large it is, in whole pixels; the glyphs are outlines in the colour it is given
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="743" height="276" /);
  assert.match(svg, /<path /);
  assert.match(svg, /currentColor/);
  assert.doesNotMatch(svg, /<text/);
});

test("signs that only say a formula follows are dropped", () => {
  const plain = typeset("E = mc^2");
  for (const wrapped of ["$E = mc^2$", "$$E = mc^2$$", "\\(E = mc^2\\)", " \\[ E = mc^2 \\] "]) assert.equal(typeset(wrapped).width, plain.width, wrapped);
});

test("LaTeX that cannot be typeset says why", () => {
  assert.throws(() => typeset("\\fraq{a}{b}"), /Undefined control sequence \\fraq/);
  assert.throws(() => typeset("\\frac{a}{b"), /Missing close brace/);
  assert.throws(() => typeset("\\begin{matrix} a"), /Missing \\end\{matrix\}/);
  assert.throws(() => typeset("x \\tag{1}"), /equation numbers are not supported/);
  assert.throws(() => typeset("{}"), /draws nothing/);
});

test("the maths the guide promises is there", () => {
  for (const tex of [
    "\\alpha \\beta \\theta \\lambda \\pi \\sigma \\Delta \\Sigma \\Omega",
    "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
    "x \\in \\mathbb{R}^n,\\ \\mathbf{W},\\ \\mathcal{L},\\ \\boldsymbol{\\theta}",
    "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
    "f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}",
    "\\begin{aligned} a &= b + c \\\\ &= d \\end{aligned}",
    "a \\\\ b",
    "\\textcolor{#e03131}{\\theta} \\leftarrow \\theta - \\alpha \\nabla J(\\theta)",
    "\\cancel{x} \\quad \\underbrace{a + b}_{n} \\quad \\xrightarrow{f} \\quad 90\\degree",
  ]) {
    assert.ok(typeset(tex).width > 0.5, tex);
  }
});

test("every formula in the guide can be typeset", () => {
  const guide = readFileSync(path.join(import.meta.dirname, "../docs/format.md"), "utf8");
  const formulas = [...guide.matchAll(/"tex": ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
  assert.ok(formulas.length >= 2);
  for (const tex of formulas) assert.ok(typeset(tex).width > 0.5, tex);
});
