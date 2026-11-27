import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { check } from "../src/format/check.ts";
import { expand } from "../src/format/expand.ts";
import { parseFunction, plotPoints } from "../src/shared/expr.ts";
import { partialPolyline, polylineLength, reversePath, subPath } from "../src/player/motion.ts";

const examples = path.join(import.meta.dirname, "../examples");
const box = (id, x, y = 100, extra = {}) => ({ id, type: "rectangle", x, y, width: 160, height: 80, ...extra });
const report = (...steps) => check({ drawcast: 1, steps }, examples);

test("functions are read the way they are written on paper", () => {
  const at = (src, x) => parseFunction(src)(x);
  assert.equal(at("x^2 / 4", 2), 1);
  assert.equal(at("2x + 1", 3), 7);
  assert.equal(at("-x^2", 3), -9);
  assert.equal(at("2^3^2", 0), 512);
  assert.ok(Math.abs(at("2 sin(pi x / 2)", 1) - 2) < 1e-12);
  assert.equal(at("sigmoid(0)", 0), 0.5);
  assert.equal(at("relu(x - 1)", 0), 0);
  assert.equal(at("1. + .5", 0), 1.5);
  for (const bad of ["x +", "foo(x)", "sin x", "(x", "x $ 2", "1.2.3x", "constructor(x)", "__proto__", "."]) assert.throws(() => parseFunction(bad), undefined, bad);
});

test("a plot fills its box, y up, and leaves out what is out of range", () => {
  const pts = plotPoints(parseFunction("x"), { x: 100, y: 100, width: 200, height: 100 }, [0, 1], undefined, 4);
  assert.deepEqual(pts[0], [100, 200]);
  assert.deepEqual(pts.at(-1), [300, 100]);
  const clipped = plotPoints(parseFunction("x^2"), { x: 0, y: 0, width: 100, height: 100 }, [-2, 2], [0, 1], 40);
  assert.ok(clipped.every(([, y]) => y >= -1e-6 && y <= 100 + 1e-6));
  assert.ok(clipped.length < 41);
  const steep = plotPoints(parseFunction("10000x"), { x: 0, y: 0, width: 100, height: 100 }, [-2, 2], [1, 2], 4);
  assert.equal(steep.length, 2);
  assert.ok(Math.abs(steep[0][0] - 50.0025) < 1e-8);
  assert.equal(steep[0][1], 100);
  assert.equal(steep[1][1], 0);
});

test("a colour by name is a stroke and, on a shape, a fill", () => {
  const out = expand({
    drawcast: 1,
    steps: [{ do: [{ add: [box("a", 0, 100, { color: "blue" }), { id: "t", type: "text", x: 0, y: 0, text: "hi", color: "red" }] }, { update: { id: "a", color: "green" } }] }],
  });
  const [a, t] = out.steps[0].do[0].add;
  assert.deepEqual([a.strokeColor, a.backgroundColor, a.color], ["#1971c2", "#a5d8ff", undefined]);
  assert.deepEqual([t.strokeColor, t.backgroundColor], ["#e03131", undefined]);
  assert.deepEqual([out.steps[0].do[1].update.strokeColor, out.steps[0].do[1].update.backgroundColor], ["#2f9e44", "#b2f2bb"]);
});

test("a line with fn becomes the points of the plot", () => {
  const out = expand({ drawcast: 1, steps: [{ do: [{ add: { id: "c", type: "line", fn: "x^2", domain: [-1, 1], x: 0, y: 0, width: 100, height: 50 } }] }] });
  const c = out.steps[0].do[0].add;
  assert.ok(c.points.length > 50);
  assert.equal(c.fn, undefined);
  assert.equal(c.roughness, 0);
});

test("a plot parameter updates references at the new value and keeps the same axes", async () => {
  const wave = { id: "wave", type: "line", fn: "sin(x+p)", p: 0, domain: [0, 6], range: [-1, 1], x: 20, y: 30, width: 200, height: 100 };
  const actions = [{ add: wave }, { update: { id: "wave", p: Math.PI / 2, dx: 50 } }, { point: ["wave", 0] }];
  assert.deepEqual((await report({ do: actions })).errors, []);
  const [added, , pointed] = expand({ drawcast: 1, steps: [{ do: actions }] }).steps[0].do;
  assert.equal(added.add.fn, wave.fn);
  assert.deepEqual(pointed.point, [70, 30]);
  for (const [changes, message] of [
    [{ p: undefined }, /starting number/], [{ range: undefined }, /fixed "range"/], [{ p: Infinity }, /finite number/],
  ]) assert.match((await report({ do: [{ add: { ...wave, ...changes } }] })).errors.join("\n"), message);
  assert.match((await report({ do: [{ add: box("b", 0) }, { update: { id: "b", p: 1 } }] })).errors.join("\n"), /starting "p"/);
  assert.match((await report({ do: [{ add: wave }, { update: { id: "wave", p: "pi" } }] })).errors.join("\n"), /must be a number/);
});

test("plots lift the pen at clipped and undefined stretches, including when travelling in reverse", () => {
  const spec = { id: "p", type: "line", fn: "1 / x", domain: [-2, 2], range: [-2, 2], x: 0, y: 0, width: 300, height: 200 };
  const plot = expand({ drawcast: 1, steps: [{ do: [{ add: spec }] }] }).steps[0].do[0].add;
  assert.equal(plot.breaks.length, 1);
  const split = plot.breaks[0];
  assert.ok(plot.points.slice(0, split).every(([x]) => x < 150));
  assert.ok(plot.points.slice(split).every(([x]) => x > 150));
  const path = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0, move: true }, { x: 25, y: 0 }];
  assert.equal(polylineLength(path), 10);
  assert.equal(partialPolyline(path, 0.6).at(-1).x, 21);
  assert.equal(partialPolyline(reversePath(path), 0.6).at(-1).x, 4);
  const middle = subPath(path, 0.2, 0.8);
  assert.equal(polylineLength(middle), 6);
  assert.equal(middle[2].move, true);
});

test("check accepts the new primitives and explains their mistakes", async () => {
  const ok = await report({
    say: "A ball rolls down the curve, and a message is sent.",
    do: [
      { add: [box("a", 100), box("b", 700, 100, { color: "violet", enter: "fade", label: "B" })] },
      { add: { id: "msg", type: "arrow", from: "a", to: "b", label: "hello" } },
      { add: { id: "curve", type: "line", fn: "x^2 / 4", domain: [-3, 3], x: 100, y: 300, width: 400, height: 200 } },
      { add: { id: "ball", type: "ellipse", x: 90, y: 290, width: 20, height: 20, color: "red" } },
      { at: "rolls", update: { id: "ball", along: "curve", span: [0, 0.5] } },
      { at: "sent", send: { along: "msg", color: "blue" } },
      { pulse: ["b", "msg"] },
      { update: { id: "b", label: "got it" } },
    ],
  });
  assert.deepEqual(ok, { errors: [], warnings: [] });

  const bad = await report({
    say: "Mistakes.",
    do: [
      { add: [box("a", 100), box("b", 700)] },
      { add: { id: "msg", type: "arrow", from: "a", to: "b" } },
      { add: { id: "p", type: "line", fn: "sin x", domain: [0, 1], x: 0, y: 300, width: 100, height: 100 } },
      { update: { id: "a", label: "new" } },
      { update: { id: "msg", along: "a" } },
      { send: "a" },
      { add: box("c", 100, 400, { color: "purple" }) },
    ],
  });
  assert.equal(bad.errors.length, 6, bad.errors.join("\n"));
  assert.match(bad.errors[0], /"fn" could not be read/);
  assert.match(bad.errors[1], /added without a label/);
  assert.match(bad.errors[2], /"along" names "a", a rectangle/);
  assert.match(bad.errors[3], /"msg" is a arrow, which cannot travel|is a arrow/);
  assert.match(bad.errors[4], /"send" runs along arrows and lines/);
  assert.match(bad.errors[5], /color must be one of/);
});

test("arrows that cross, or run through something, are warned about", async () => {
  const { warnings } = await report({
    say: "Four corners and a box in the way.",
    do: [
      { add: [box("tl", 100, 100), box("tr", 900, 100), box("bl", 100, 450), box("br", 900, 450)] },
      { add: { id: "d1", type: "arrow", from: "tl", to: "br" } },
      { add: { id: "d2", type: "arrow", from: "tr", to: "bl" } },
      { add: box("mid", 500, 100) },
      { add: { id: "top", type: "arrow", from: "tl", to: "tr" } },
    ],
  });
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0], /crosses the arrow "d1"/);
  assert.match(warnings[1], /runs through "mid"/);
});

test("enter can be given on the element or on the action", async () => {
  for (const action of [{ add: box("a", 100, 100, { enter: "fade" }) }, { enter: "fade", add: box("a", 100) }]) {
    assert.deepEqual((await report({ say: "One box.", do: [action] })).errors, []);
  }
});

test("text and formulas change size with fontSize; shapes do not take it", async () => {
  const { errors } = await report({
    say: "A title shrinks.",
    do: [
      { add: [{ id: "t", type: "text", x: 640, y: 300, text: "Title", fontSize: 48, textAlign: "center" }, box("b", 100)] },
      { at: "shrinks", update: { id: "t", fontSize: 24, x: 1100, y: 40 } },
      { update: { id: "b", fontSize: 30 } },
    ],
  });
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /"fontSize" changes the size of a text or math element; "b" is a rectangle/);
});

test("a label too long for its arrow is warned about", async () => {
  const { warnings } = await report({
    say: "Two boxes close together.",
    do: [{ add: [box("a", 100), box("b", 330)] }, { add: { id: "ab", type: "arrow", from: "a", to: "b", label: "a long label here" } }, { send: { along: "ab", reverse: true } }],
  });
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /will cover the arrow/);
});

test("arrow label warnings measure the shaft underneath horizontal text", async () => {
  const warnings = async (to, label) => (await report({ do: [{ add: { id: "a", type: "arrow", from: [100, 100], to, label } }] })).warnings;
  assert.deepEqual(await warnings([100, 185], "npx, on first use"), []);
  assert.deepEqual(await warnings([160, 160], "npx, on first use"), []);
  assert.match((await warnings([185, 100], "npx, on first use"))[0], /will cover the arrow/);
  for (const to of [[100, 185], [160, 160]]) {
    assert.match((await warnings(to, "first line\nsecond line\nthird line\nfourth line"))[0], /will cover the arrow/);
  }
});

test("--step takes numbers, lists, ranges and all, with commas or spaces", async () => {
  const { parseSteps } = await import("../src/render/render.ts");
  assert.deepEqual(parseSteps("3", 9), [3]);
  assert.deepEqual(parseSteps("2,5,9", 9), [2, 5, 9]);
  assert.deepEqual(parseSteps("4 7", 9), [4, 7]);
  assert.deepEqual(parseSteps("3-5", 9), [3, 4, 5]);
  assert.deepEqual(parseSteps("all", 3), [1, 2, 3]);
  assert.throws(() => parseSteps("x", 3));
});

test("a point of a plot is named by the plot and its x", async () => {
  const plot = { id: "loss", type: "line", fn: "x^2", domain: [-2, 2], range: [0, 4], x: 100, y: 100, width: 400, height: 200 };
  const steps = [
    {
      say: "A ball on the curve rolls to the bottom.",
      do: [
        { add: plot },
        { add: { id: "ball", type: "ellipse", on: ["loss", -2], width: 20, height: 20 } },
        { add: { id: "tan", type: "arrow", from: ["loss", -1], to: ["loss", 1] } },
        { at: "rolls", update: { id: "ball", along: [["loss", -2], ["loss", 0]] } },
        { point: ["loss", 0] },
      ],
    },
  ];
  assert.deepEqual(await check({ drawcast: 1, steps }, examples), { errors: [], warnings: [] });
  const out = expand({ drawcast: 1, steps });
  const [, ball, tan, roll, point] = out.steps[0].do.map((a) => a.add ?? a.update ?? a.point);
  // x = -2 is the box's left edge and y = 4 its top
  assert.deepEqual([ball.x, ball.y, ball.on], [90, 90, undefined]);
  assert.deepEqual([tan.from, tan.to], [[200, 250], [400, 250]]);
  // two points of one plot in a row are the curve between them
  assert.ok(roll.along.length > 10);
  assert.deepEqual(roll.along.at(-1), [300, 300]);
  assert.deepEqual(point, [300, 300]);

  const { errors } = await check({ drawcast: 1, steps: [{ do: [{ add: plot }, { add: { id: "b", type: "ellipse", on: ["nope", 0], width: 20, height: 20 } }, { point: ["loss", 9] }] }] }, examples);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /"nope", which is not a plot/);
});

test("part of a path runs from one fraction of its length to another", () => {
  const p = subPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.25, 0.75);
  const near = (a, b) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, JSON.stringify([a, b]));
  near(p[0], { x: 5, y: 0 });
  near(p.at(-1), { x: 10, y: 5 });
});

test("plot points follow a translated line and become unavailable after removal", async () => {
  const plot = { id: "p", type: "line", fn: "x", domain: [0, 1], x: 0, y: 0, width: 100, height: 100 };
  const actions = [{ add: plot }, { update: { id: "p", dx: 50, dy: 25 } }, { point: ["p", 1] }];
  assert.deepEqual((await report({ do: actions })).errors, []);
  assert.deepEqual(expand({ drawcast: 1, steps: [{ do: actions }] }).steps[0].do[2].point, [150, 25]);
  const { errors } = await report({ do: [
    ...actions,
    { add: box("a", 300) },
    { update: { id: "a", along: [["missing", 1], [0, 1]] } },
    { add: { id: "arrow", type: "arrow", from: "a", to: "p" } },
    { update: { id: "p", width: 20 } },
    { remove: "p" },
    { point: ["p", 0.5] },
  ] });
  assert.equal(errors.length, 4, errors.join("\n"));
  assert.match(errors[0], /"missing".*not a plot/);
  assert.match(errors[1], /arrows attach to shapes/);
  assert.match(errors[2], /move it with dx and dy/);
  assert.match(errors[3], /"p".*not a plot/);
});

test("palette updates fill closed polygons and keep mixed targets together", () => {
  const polygon = { id: "p", type: "line", closed: true, points: [[0, 0], [1, 0], [0, 1]] };
  const text = { id: "t", type: "text", x: 50, y: 0, text: "Hi" };
  const out = expand({ drawcast: 1, steps: [{ do: [
    { add: [polygon, text] },
    { update: { id: "p", color: "red" } },
    { update: { id: ["p", "t"], color: "blue" } },
  ] }] });
  assert.equal(out.steps[0].do[1].update.backgroundColor, "#ffc9c9");
  assert.deepEqual(out.steps[0].do[2].update, { id: ["p", "t"], color: "blue", strokeColor: "#1971c2" });
});

test("explicit strokes and routes follow the visible parts of a rotated plot", async () => {
  const spec = { id: "p", type: "line", fn: "1/x", domain: [-2, 2], range: [-2, 2], x: 0, y: 0, width: 300, height: 200, angle: Math.PI / 2 };
  const refs = [["p", -2], ["p", 2]];
  const actions = [
    { add: spec }, { point: refs[0] }, { add: { type: "freedraw", id: "trace", points: refs } },
    { add: box("ball", 520) }, { update: { id: "ball", along: refs.toReversed() } },
    { update: { id: "p", dx: 10, angle: 0 } }, { point: refs[0] },
  ];
  assert.deepEqual((await report({ do: actions })).errors, []);
  const list = expand({ drawcast: 1, steps: [{ do: actions }] }).steps[0].do;
  assert.ok(Math.abs(list[1].point[0] - 125) < 1e-9);
  assert.ok(Math.abs(list[1].point[1] + 50) < 1e-9);
  assert.deepEqual(list[6].point, [10, 125]);
  const trace = list[2].add, move = list[4].update;
  assert.equal(trace.breaks.length, 1);
  assert.deepEqual(move.along, trace.points.toReversed());
  assert.deepEqual(move.breaks, [trace.points.length - trace.breaks[0]]);
});
