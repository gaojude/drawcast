import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { findBrowser, launchBrowser } from "../src/render/browser.ts";

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
