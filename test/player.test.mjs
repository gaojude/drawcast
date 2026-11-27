import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { findBrowser, launchBrowser } from "../src/render/browser.ts";
import { expand } from "../src/format/expand.ts";
import { check } from "../src/format/check.ts";
import { axesImageKey, axesLayout } from "../src/shared/axes.ts";

test("the browser timeline", async (t) => {
  if (!await findBrowser(false, () => {})) return t.skip("requires an installed Chrome, Chromium or Edge");
  const root = path.join(import.meta.dirname, "..");
  const { outputFiles } = await build({
    absWorkingDir: root, entryPoints: ["src/player/compile.ts"], outfile: "timeline.js",
    bundle: true, format: "iife", globalName: "player", write: false, minify: true,
    define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
    loader: { ".woff2": "empty" },
  });
  const browser = await launchBrowser(() => {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addScriptTag({ content: outputFiles.find((f) => f.path.endsWith(".js")).text });
  const run = (steps, times = [10], images = [], audio = steps.map(() => null)) => page.evaluate((steps, times, images, audio) => {
    const timeline = player.timeline({ drawcast: 1, steps }, new Map(images), () => undefined);
    const schedule = timeline.extend(audio);
    return { schedule, frames: times.map((time) => timeline.frameAt(time)) };
  }, steps, times, images, audio);
  const box = (id, x, extra = {}) => ({ type: "rectangle", id, x, y: 0, width: 100, height: 100, ...extra });
  const arrow = (from, to) => ({ type: "arrow", id: "edge", from, to });
  const at = (frame, id) => frame.elements.find((el) => el.id === id);

  await t.test("update entries share their spoken cue and explicit duration", async () => {
    const steps = [{ say: "Ready, move.", do: [
      { enter: "none", add: [box("left", 0), box("right", 300)] },
      { at: "move", duration: 2, update: [{ id: "left", dx: 120 }, { id: "right", dy: 200 }] },
    ] }];
    const voice = { duration: 4, tokens: [{ token: "ready", t: 0 }, { token: "move", t: 1 }], captions: [] };
    const { frames } = await run(steps, [1.49, 2.5, 3.5], [], [voice]);
    assert.deepEqual(frames.map((frame) => [at(frame, "left").x, at(frame, "right").y]),
      [[0, 0], [60, 100], [120, 200]]);
  });

  await t.test("implicit actions wait for the longest member of an update", async () => {
    const steps = [{ do: [
      { enter: "none", add: [box("traveler", 0), box("station", 300)] },
      { duration: 0.5, update: { id: "station", dx: 40 } },
      { update: [{ id: "traveler", along: [[50, 50], [170, 50]] }, { id: "station", dy: 80 }] },
      { enter: "none", add: box("done", 600) },
    ] }];
    const { frames: [before, moving, shorterDone, longestDone] } = await run(steps, [0.99, 1.2, 1.6, 2.21]);
    assert.deepEqual([at(before, "traveler").x, at(before, "station").y], [0, 0]);
    assert.ok(at(moving, "traveler").x > 0 && at(moving, "station").y > 0);
    assert.ok(Math.abs(at(shorterDone, "traveler").x - 60) < 1e-6);
    assert.equal(at(shorterDone, "station").y, 80);
    assert.equal(at(shorterDone, "done"), undefined);
    assert.equal(at(longestDone, "traveler").x, 120);
    assert.ok(at(longestDone, "done"));
  });

  await t.test("an instant update replaces text and a bound label together on the cue frame", async () => {
    const steps = [{ do: [
      { enter: "none", add: [box("entry", 0, { label: "First" }), { id: "address", type: "text", x: 300, y: 0, text: "Home" }] },
      { at: 1, duration: 0, update: [{ id: "address", text: "Shop" }, { id: "entry", label: "Second" }] },
    ] }];
    const { frames } = await run(steps, [1.49, 1.5, 1.51]);
    const displayed = frames.map((frame) => {
      const text = at(frame, "address"), label = frame.elements.find((el) => el.containerId === "entry");
      return [text.text, label.text, text.opacity, label.opacity];
    });
    assert.deepEqual(displayed, [["Home", "First", 100, 100], ["Shop", "Second", 100, 100], ["Shop", "Second", 100, 100]]);
  });

  await t.test("a clockwise slice sweeps with its fill from the spoken cue and closes a full disk", async () => {
    const { steps } = expand({ drawcast: 1, steps: [{ say: "Ready, draw.", do: [
      { at: "draw", duration: 2, add: { id: "disk", type: "slice", center: [150, 200], radius: 100, share: 100, color: "teal" } },
    ] }] });
    const voice = { duration: 4, tokens: [{ token: "ready", t: 0 }, { token: "draw", t: 1 }], captions: [] };
    const { frames: [before, zero, half, full] } = await run(steps, [1.49, 1.5, 2.5, 3.5], [], [voice]);
    assert.equal(at(before, "disk"), undefined);
    assert.equal(at(zero, "disk").opacity, 0);
    const wedge = at(half, "disk");
    assert.equal(wedge.backgroundColor, "#96f2d7");
    assert.deepEqual([wedge.x, wedge.y, wedge.width, wedge.height], [150, 200, 100, 200]);
    assert.deepEqual(wedge.points.slice(0, 2), [[0, 0], [0, -100]]);
    assert.deepEqual(wedge.points.at(-1), [0, 0]);
    const disk = at(full, "disk");
    assert.deepEqual([disk.width, disk.height], [200, 200]);
    assert.deepEqual(disk.points[0], disk.points.at(-1));
    assert.ok(disk.points.every(([x, y]) => Math.abs(Math.hypot(disk.x + x - 150, disk.y + y - 200) - 100) < 1e-8));
  });

  await t.test("slice labels stay inside on fade, palette change, move, rotation, pulse and remove", async () => {
    const { steps } = expand({ drawcast: 1, steps: [{ do: [
      { duration: 1, enter: "fade", add: { id: "w", type: "slice", center: [220, 260], radius: 100, start: 25, share: 50, color: "teal", label: "Food\n50%" } },
      { enter: "none", add: { id: "t", type: "text", x: 0, y: 0, text: "Total" } },
      { at: 2, duration: 0, update: { id: ["w", "t"], color: "blue", dx: 50 } },
      { at: 2, duration: 0, update: { id: "w", label: "Rent", angle: Math.PI / 2 } },
      { at: 3, duration: 1, pulse: "w" },
      { at: 5, duration: 0, remove: "w" },
    ] }] });
    const { frames: [fade, moved, pulsed, gone] } = await run(steps, [1, 2.5, 4, 5.5]);
    const label = (frame) => frame.elements.find((el) => el.sliceId === "w");
    const center = (el) => [el.x + el.width / 2, el.y + el.height / 2].map(Math.round);
    assert.deepEqual([label(fade).text, label(fade).opacity, at(fade, "w").opacity], ["Food\n50%", 50, 50]);
    assert.deepEqual(center(label(fade)), [220, 320]);
    assert.deepEqual([label(moved).text, label(moved).strokeColor, at(moved, "w").backgroundColor], ["Rent", "#1971c2", "#a5d8ff"]);
    assert.deepEqual(center(label(moved)), [210, 260]);
    assert.deepEqual(center(label(pulsed)), [202, 260]);
    assert.ok(at(pulsed, "w").height > at(moved, "w").height);
    assert.deepEqual(gone.elements.map((el) => el.id), ["t"]);
  });

  await t.test("axes keep their chart and label margins together when moving, fitting and removing", async () => {
    const axes = { id: "scale", type: "axes", x: 30, y: 40, width: 400, height: 200, domain: [-2, 2], range: [0, 1], xTicks: [0, 1], yTicks: [0.5], xLabel: "input" };
    const layout = axesLayout(axes);
    const { frames: [shown, moved, gone] } = await run([{ do: [
      { enter: "none", add: axes },
      { at: 1, duration: 0, update: { id: "scale", dx: 50, opacity: 60 } },
      { at: 1, duration: 0, camera: { fit: ["scale"], padding: 0 } },
      { at: 2, duration: 0, remove: "scale" },
    ] }], [0.5, 1.5, 2.5], [[axesImageKey("scale"), { fileId: "axes-vector" }]]);
    const el = at(shown, "scale");
    assert.deepEqual([el.type, el.fileId, el.x, el.y], ["image", "axes-vector", axes.x + layout.left, axes.y + layout.top]);
    assert.deepEqual([at(moved, "scale").x, at(moved, "scale").opacity], [el.x + 50, 60]);
    assert.ok(moved.view.w >= layout.width && moved.view.h >= layout.height);
    assert.equal(at(gone, "scale"), undefined);
  });

  await t.test("a reading on axes moved along a rotated named path lands on the rendered chart", async () => {
    const axes = { id: "scale", type: "axes", x: 40, y: 60, width: 200, height: 100, domain: [0, 4], range: [0, 1], xLabel: "Hours", yTicks: [0, 0.5, 1] };
    const rail = { id: "rail", type: "line", points: [[300, 200], [500, 200]], roughness: 0 };
    const script = { drawcast: 1, steps: [{ do: [
      { enter: "none", add: [axes, rail] },
      { duration: 0, update: { id: "rail", dy: 10, angle: Math.PI / 2 } },
      { duration: 1, update: { id: "scale", along: "rail", span: [0.1, 0.75] } },
      { enter: "none", add: { id: "marker", type: "ellipse", on: ["scale", 3, 0.25], width: 12, height: 12 } },
    ] }] };
    const readings = new WeakMap();
    assert.deepEqual((await check(script, root, readings)).errors, []);
    const { frames: [frame] } = await run(expand(script, readings).steps, [2], [[axesImageKey("scale"), { fileId: "scale" }]]);
    const chart = at(frame, "scale"), marker = at(frame, "marker");
    const { left, top } = axesLayout(axes);
    assert.deepEqual([chart.x + chart.width / 2, chart.y + chart.height / 2], [400, 260]);
    assert.deepEqual([marker.x + 6, marker.y + 6], [chart.x - left + 150, chart.y - top + 75]);
  });

  await t.test("phase changes move a crest continuously and keep the sum in sync", async () => {
    const plot = (id, fn) => ({ type: "line", id, fn, p: 0, domain: [0, Math.PI * 2], range: [-2, 2], x: 0, y: 0, width: 192, height: 200 });
    const script = expand({ drawcast: 1, steps: [{ do: [
      { enter: "none", add: [plot("wave", "sin(x+p)"), plot("sum", "sin(x)+sin(x+p)")] },
      { at: 0, duration: 2, update: { id: ["wave", "sum"], p: Math.PI } },
      { at: 0, duration: 2, update: { id: "wave", dx: 20 } },
      { at: 0, duration: 0.5, update: { id: "wave", strokeColor: "#ff0000" } },
    ] }] });
    const { frames: [initial, mid, end, midAgain] } = await run(script.steps, [0.5, 1.5, 2.5, 1.5]);
    assert.deepEqual(mid, midAgain);
    assert.equal(at(initial, "wave").y, 100);
    assert.equal(at(mid, "wave").y, 50); // a displaced crest at x = 0
    assert.equal(at(mid, "wave").x, 10);
    assert.equal(at(mid, "wave").strokeColor, "#ff0000");
    assert.equal(at(mid, "sum").y, 50);
    assert.equal(at(end, "wave").height, 100);
    assert.ok(at(end, "sum").height < 1e-10);
  });

  await t.test("parameterized plots preserve breaks and can leave the visible range between keyframes", async () => {
    const plot = (id, fn) => ({ type: "line", id, fn, p: -1, domain: [-2, 2], range: [-2, 2], x: 0, y: 0, width: 200, height: 100 });
    const { steps } = expand({ drawcast: 1, steps: [{ do: [
      { enter: "none", add: [plot("pole", "1/(x-p)"), plot("hidden", "1/p")] },
      { at: 0, duration: 2, update: { id: ["pole", "hidden"], p: 1 } },
      { at: 0, duration: 2, send: "hidden" },
      { at: 0, duration: 2, point: "hidden" },
    ] }] });
    const { frames: [mid, end] } = await run(steps, [1.5, 2.5]);
    assert.equal(at(mid, "hidden"), undefined);
    assert.equal(mid.pointers.length, 0);
    assert.ok(at(mid, "pole/segment-1").x > 100);
    assert.ok(at(end, "hidden"));
    assert.ok(at(end, "pole/segment-1").x > 150);
  });

  await t.test("connections follow both simultaneously moving ends, then freeze the removed end", async () => {
    const steps = [{ do: [
      { enter: "none", add: [box("left", 0), box("right", 300), arrow("left", "right")] },
      { at: 0, duration: 2, update: { id: "left", dx: 100 } },
      { at: 0, duration: 1, update: { id: "right", dx: 100 } },
      { at: 2, duration: 0, remove: "right" },
      { at: 3, duration: 0, update: { id: "left", dx: -100 } },
      { at: 4, duration: 0, update: { id: "edge", dx: 20 } },
    ] }];
    const { frames } = await run(steps, [0.5, 1, 1.5, 2, 3, 4, 5]);
    for (const f of frames.slice(0, -1)) {
      const edge = at(f, "edge");
      assert.equal(edge.x, at(f, "left").x + 108);
      const right = at(f, "right");
      assert.equal(edge.x + edge.points.at(-1)[0], (right?.x ?? 400) - 8);
      assert.equal(edge.endBinding?.elementId ?? null, right?.id ?? null);
    }
    const moved = at(frames.at(-1), "edge");
    assert.deepEqual([moved.x, moved.startBinding, moved.endBinding], [128, null, null]);
  });

  await t.test("rotation affects attachment, camera fit and the label angle", async () => {
    const { frames: [f] } = await run([{ do: [
      { enter: "none", add: [box("box", 0, { width: 200, height: 80, label: "label", opacity: 0 }), arrow("box", [400, 40])] },
      { duration: 0, update: { id: "box", angle: Math.PI / 2 } },
      { duration: 0, camera: { fit: ["box"], padding: 0 } },
    ] }]);
    assert.equal(at(f, "edge").x, 148);
    assert.equal(f.view.h, 200);
    const label = f.elements.find((e) => e.containerId === "box");
    assert.equal(label.angle, Math.PI / 2);
    assert.equal(label.opacity, 0);
  });

  await t.test("coincident centers and instant pointers have finite coordinates", async () => {
    const { frames: [f] } = await run([{ do: [
      { enter: "none", add: [box("circle", 0, { type: "ellipse" }), arrow("circle", "circle")] },
      { at: 0, duration: 0, point: [10, 10] },
      { at: 0, duration: 0, send: "edge" },
    ] }], [0.5]);
    const edge = at(f, "edge");
    assert.ok([edge.x, edge.y, ...edge.points.flat()].every(Number.isFinite));
    assert.equal(at(f, "circle").boundElements.length, 1);
    assert.equal(f.pointers.length, 2);
    assert.ok(f.pointers.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  });

  await t.test("an image sized by height retains its proportions", async () => {
    const { frames: [f] } = await run([{ do: [
      { add: { type: "image", id: "image", src: "image.png", x: 0, y: 0, height: 50 } },
    ] }], [2], [["image.png", { fileId: "image", width: 800, height: 200 }]]);
    assert.deepEqual([at(f, "image").width, at(f, "image").height], [200, 50]);
  });

  await t.test("a pulse keeps moving with its target and an interrupted camera pan stays continuous", async () => {
    const { frames: [before, atPulse, after] } = await run([{ do: [
      { enter: "none", add: box("target", 0) },
      { at: 0, duration: 2, update: { id: "target", dx: 200 } },
      { at: 0, duration: 2, camera: { x: 200, y: 0, width: 1000 } },
      { at: 0.5, duration: 1, pulse: "target" },
      { at: 1, duration: 1, camera: "reset" },
    ] }], [1.499999, 1.5, 2.5]);
    const target = at(atPulse, "target");
    assert.equal(target.x + target.width / 2, 150);
    assert.ok(target.width > 110);
    assert.ok(Math.abs(before.view.x - atPulse.view.x) < 0.01);
    assert.equal(atPulse.view.x, 100);
    assert.equal(after.view.x, 0);
    assert.equal(at(after, "target").width, 100);
  });

  await t.test("a shorter simultaneous color change leaves motion and label placement intact", async () => {
    const { frames } = await run([{ do: [
      { enter: "none", add: box("target", 0, { label: "Moving" }) },
      { at: 0, duration: 2, update: { id: "target", dx: 200 } },
      { at: 0, duration: 0.5, update: { id: "target", strokeColor: "#ff0000" } },
      { at: 1.5, duration: 1, update: { id: "target", x: 0 } },
    ] }], [0.5, 1.5, 1.999999, 2, 3]);
    assert.equal(at(frames[0], "target").x, 0);
    assert.equal(at(frames[1], "target").x, 100);
    assert.equal(at(frames[1], "target").strokeColor, "#ff0000");
    assert.ok(Math.abs(at(frames[2], "target").x - at(frames[3], "target").x) < 0.01);
    assert.equal(at(frames[4], "target").x, 0);
    for (const frame of frames) {
      const target = at(frame, "target");
      const label = frame.elements.find((e) => e.containerId === target.id);
      assert.equal(label.x + label.width / 2, target.x + target.width / 2);
    }
  });

  await t.test("a pause after a spoken step waits for its longest action", async () => {
    const { schedule } = await run([{ say: "Here.", pause: 1, do: [{ duration: 4, add: box("box", 0) }] }, { duration: 1 }],
      [], [], [{ duration: 1, tokens: [], captions: [] }, null]);
    assert.equal(schedule.stepStarts[1] - schedule.stepStarts[0], 5);
  });

  await t.test("drawing, travel and sent dots use the rotated path on screen", async () => {
    const line = { type: "line", id: "rail", points: [[90, 120], [270, 120]], roughness: 0, angle: Math.PI / 2 };
    const { frames: [half, sending, arrived] } = await run([{ do: [
      { duration: 2, add: line },
      { enter: "none", add: box("ball", 170, { y: 20, width: 20, height: 20 }) },
      { at: 2, duration: 2, send: "rail" },
      { at: 2, duration: 2, update: { id: "ball", along: "rail" } },
    ] }], [1.5, 3, 4.5]);
    const drawn = at(half, "rail");
    assert.deepEqual([drawn.x, drawn.y, drawn.angle], [180, 30, 0]);
    assert.equal(drawn.points.at(-1)[1], 90);
    assert.equal(sending.pointers[0].x, 180);
    assert.ok(sending.pointers[0].trail.every((point) => point.x === 180));
    assert.deepEqual([at(arrived, "ball").x, at(arrived, "ball").y], [170, 200]);
  });

  await t.test("pointers follow simultaneous moves, and removal freezes the visible position", async () => {
    const { frames: [active, fading, removed] } = await run([{ do: [
      { enter: "none", add: [box("left", 0), box("right", 400), arrow("left", "right")] },
      { at: 0, duration: 2, update: { id: ["left", "right"], dy: 200 } },
      { at: 0, duration: 2, send: "edge" },
      { at: 0, duration: 2, point: "left" },
      { at: 1, duration: 0.5, remove: "left" },
    ] }], [1, 1.75, 2]);
    const y = at(active, "left").y + 50;
    assert.equal(active.pointers[0].y, y);
    assert.ok(active.pointers[0].trail[0].y < y);
    assert.ok(Math.abs(active.pointers[1].y - y) <= 31);
    assert.equal(at(fading, "left").y, 100);
    const oldEdge = at(fading, "edge"), edge = at(removed, "edge");
    assert.ok(edge.y < 200);
    assert.ok(Math.abs(oldEdge.y - edge.y) < 20);
    assert.equal(edge.startBinding, null);
  });
});
