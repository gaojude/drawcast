import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Browser, computeExecutablePath, detectBrowserPlatform } from "@puppeteer/browsers";
import { findBrowser, launchBrowser } from "../src/render/browser.ts";

test("browser discovery reuses a downloaded build while offline", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-browser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const key of ["DRAWCAST_HOME", "DRAWCAST_BROWSER", "PATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = dir;
  }
  delete process.env.DRAWCAST_BROWSER;
  if (process.platform === "darwin" && await findBrowser(false, () => {})) return t.skip("A system browser takes precedence on this Mac.");
  t.mock.method(globalThis, "fetch", () => assert.fail("browser discovery contacted the network"));
  assert.equal(await findBrowser(false, () => {}), null);
  const executable = computeExecutablePath({
    browser: Browser.CHROMEHEADLESSSHELL, platform: detectBrowserPlatform(), buildId: "127.0.0.1", cacheDir: path.join(dir, "browser"),
  });
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "", { mode: 0o755 });
  assert.equal(await findBrowser(true, () => assert.fail("started a download")), executable);
});

test("aborting a fresh install closes the installer connection and removes its staging directory", { timeout: 15000 }, async (t) => {
  if (process.platform === "darwin" && await findBrowser(false, () => {})) return t.skip("A system browser takes precedence on this Mac.");
  const dir = mkdtempSync(path.join(os.tmpdir(), "drawcast-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = ["DRAWCAST_HOME", "DRAWCAST_BROWSER", "PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA", "NODE_OPTIONS", ...(process.platform === "win32" ? [] : ["PATH"])];
  for (const key of env) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = dir;
  }
  delete process.env.DRAWCAST_BROWSER;
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const preload = path.join(dir, "local-version-server.mjs");
  const chrome = new URL("./browser-data/chrome.js", import.meta.resolve("@puppeteer/browsers"));
  writeFileSync(preload, `import { changeBaseVersionUrlForTesting } from ${JSON.stringify(chrome.href)}; changeBaseVersionUrlForTesting("http://127.0.0.1:${server.address().port}");`);
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  const controller = new AbortController();
  const waiting = once(server, "request");
  const installing = findBrowser(true, () => {}, controller.signal);
  try {
    const [req] = await Promise.race([waiting, installing.then(() => assert.fail("expected an installation request"))]);
    const disconnected = new Promise((resolve) => req.socket.once("close", resolve));
    controller.abort(new Error("installation cancelled"));
    await assert.rejects(installing, /installation cancelled/);
    await disconnected;
    assert.deepEqual(readdirSync(path.join(dir, "browser")), []);
    assert.equal(await findBrowser(false, () => {}), null);
  } finally {
    controller.abort();
    await installing.catch(() => {});
  }
});

test("cancelling a browser closes its process without installing process signal handlers", async (t) => {
  if (!await findBrowser(false, () => {})) return t.skip("requires an installed browser");
  const controller = new AbortController();
  const before = ["SIGINT", "SIGTERM"].map((event) => process.listenerCount(event));
  const browser = await launchBrowser(() => {}, controller.signal);
  try {
    assert.deepEqual(["SIGINT", "SIGTERM"].map((event) => process.listenerCount(event)), before);
    const stopped = once(browser.process(), "exit");
    controller.abort();
    await stopped;
  } finally {
    await browser.close();
  }
  await assert.rejects(launchBrowser(() => assert.fail(), controller.signal), { name: "AbortError" });
});
