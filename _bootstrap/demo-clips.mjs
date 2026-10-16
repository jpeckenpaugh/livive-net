#!/usr/bin/env node
/*
 * Real demo-clip recorder for the livive.net catalogue.
 *
 * Unlike `previews.mjs` (which can fall back to animating a thumbnail), this
 * pipeline records an actual ~30s screen capture of someone *using* the live
 * site: it loads the page, moves the cursor, hovers controls, scrolls through
 * the UI, and runs a small curated interaction script per project where one is
 * known. The result is a genuine product demo, not a pan over a still.
 *
 *   previews/<key>.webm  — ~30s silent clip (16:10), transcoded to a light vp8
 *   previews/<key>.webp  — fresh poster frame captured mid-demo
 *   previews.json        — manifest updated with mode: "demo"
 *
 * It needs a real Chromium (and Playwright's ffmpeg for recordVideo), so it is
 * intended to run in CI (ubuntu-latest) via .github/workflows/record-demos.yml:
 *
 *   node _bootstrap/demo-clips.mjs --category "Web Apps & Prototypes"
 *   node _bootstrap/demo-clips.mjs --keys oblique-livive-net herons-fountain
 *   node _bootstrap/demo-clips.mjs --keys tech-livive-net --ms 30000 --force
 */

import { mkdir, readFile, writeFile, rm, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const BOOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BOOT, "..");
const PROJECTS = path.join(ROOT, "projects.json");
const PREVIEWS_DIR = path.join(ROOT, "previews");
const MANIFEST = path.join(ROOT, "previews.json");

// Record at a crisp 16:10 surface, then downscale on export.
const VIEW = { width: 1280, height: 800 };
const OUT = { width: 960, height: 600 };
const DEFAULT_MS = Number(process.env.LIVIVE_DEMO_MS || 30000);
const NAV_TIMEOUT = 45000;
const PER_PROJECT_TIMEOUT = Number(process.env.LIVIVE_DEMO_TIMEOUT || 120000);
const CONCURRENCY = Number(process.env.LIVIVE_DEMO_CONCURRENCY || 2);

const CHROME_EXECUTABLE =
  process.env.LIVIVE_CHROME ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  null;

/* ------------------------------------------------------------------ */
/* Curated interaction scripts (best-effort; every step is non-fatal)   */
/* ------------------------------------------------------------------ */

// A step is a plain object with one action key. Supported:
//   waitForFunction{fn,timeout} waitFor{sel,timeout} wait{ms}
//   hover{sel} click{sel} clickText{text} type{sel,text} press{key}
//   scroll{y} scrollTo{y} drag{sel?,dx,dy} mouse{x,y}
const STEPS = {
  "herons-fountain": [
    { waitForFunction: () => document.querySelector("canvas"), timeout: 15000 },
    { wait: 2500 },
    { drag: { dx: 120, dy: -80 } },
    { wait: 2000 },
    { drag: { dx: -160, dy: 60 } },
    { wait: 4000 },
    { scroll: 500 }, { wait: 2500 },
  ],
  "oblique-livive-net": [
    { waitForFunction: () => document.querySelector("canvas"), timeout: 15000 },
    { wait: 3000 },
    { drag: { dx: 180, dy: 0 } },
    { wait: 1500 },
    { drag: { dx: 0, dy: 120 } },
    { wait: 2500 },
    { drag: { dx: -220, dy: -80 } },
    { wait: 3000 },
  ],
  "robot-motion-studio": [
    { wait: 2500 },
    { clickText: "Play" }, { wait: 3000 },
    { scroll: 500 }, { wait: 2000 },
    { clickText: "Run" }, { wait: 3000 },
  ],
  "executive-assistant": [
    { wait: 2000 },
    { clickText: "New" }, { wait: 1200 },
    { clickText: "Task" }, { wait: 1200 },
    { type: { sel: "input[type=text], textarea", text: "Draft the Q4 roadmap and review with the team" } },
    { wait: 1500 },
    { press: "Enter" }, { wait: 2000 },
    { clickText: "Add" }, { wait: 2000 },
  ],
  "vid-factory": [
    { wait: 2500 },
    { clickText: "New" }, { wait: 1200 },
    { type: { sel: "input[type=text], textarea", text: "A 60-second explainer on browser-native AI" } },
    { wait: 2000 },
    { clickText: "Generate" }, { wait: 4000 },
  ],
  "company-hub": [
    { wait: 2500 },
    { clickText: "Companies" }, { wait: 1500 },
    { click: { sel: "a, button" } }, { wait: 2500 },
    { scroll: 500 }, { wait: 2000 },
  ],
  "c3pa-explorer": [
    { waitForFunction: () => !/Checking for publish/i.test(document.body.innerText) && document.body.innerText.length > 400, timeout: 30000 },
    { wait: 2000 },
    { click: { sel: "a, button, tr, li" } }, { wait: 2500 },
    { scroll: 600 }, { wait: 2500 },
  ],
  "driver-hub-prototype": [
    { wait: 3000 },
    { clickText: "Ride" }, { wait: 2500 },
    { drag: { dx: 90, dy: 40 } }, { wait: 2500 },
    { clickText: "Request" }, { wait: 3000 },
  ],
  "tech-livive-net": [
    { wait: 1500 },
    { scroll: 700 }, { wait: 2500 },
    { scroll: 700 }, { wait: 2500 },
    { scroll: 700 }, { wait: 2000 },
  ],
};

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */

async function loadChromium() {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    return null;
  }
}

async function launchBrowser() {
  const chromium = await loadChromium();
  if (!chromium) throw new Error("playwright-core is not installed");
  const attempts = [];
  if (CHROME_EXECUTABLE) attempts.push({ headless: true, executablePath: CHROME_EXECUTABLE });
  attempts.push({ headless: true }); // bundled chromium (installed in CI)
  attempts.push({ headless: true, channel: "chrome" }); // fallback to system Chrome
  let lastErr;
  for (const opts of attempts) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function findFfmpeg() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return null;
  const dirs = await readdir(base).catch(() => []);
  for (const d of dirs) {
    if (!d.startsWith("ffmpeg-")) continue;
    for (const name of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg"]) {
      const p = path.join(base, d, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (err) => resolve(!err)));

/* ------------------------------------------------------------------ */
/* Interaction engine                                                 */
/* ------------------------------------------------------------------ */

async function dragAt(page, box, dx, dy) {
  const cx = box ? box.x + box.width / 2 : VIEW.width / 2;
  const cy = box ? box.y + box.height / 2 : VIEW.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

async function doStep(page, s) {
  try {
    if (s.waitForFunction) return await page.waitForFunction(s.waitForFunction, { timeout: s.timeout || 15000 });
    if (s.waitFor) return await page.waitForSelector(s.waitFor, { timeout: s.timeout || 8000 });
    if (s.wait) return await page.waitForTimeout(s.ms);
    if (s.hover) return await page.locator(s.sel).first().hover({ timeout: 3000 });
    if (s.click) return await page.locator(s.sel).first().click({ timeout: 3000 });
    if (s.clickText) return await page.getByText(new RegExp(s.clickText, "i")).first().click({ timeout: 3000 });
    if (s.type) return await page.locator(s.sel).first().fill(s.text, { timeout: 3000 });
    if (s.press) return await page.keyboard.press(s.key);
    if (s.scroll) return await page.evaluate((y) => window.scrollBy(0, y), s.y);
    if (s.scrollTo) return await page.evaluate((y) => window.scrollTo(0, y), s.y);
    if (s.mouse) return await page.mouse.move(s.mouse.x, s.mouse.y);
    if (s.drag) {
      const box = s.sel ? await page.locator(s.sel).first().boundingBox().catch(() => null) : null;
      return await dragAt(page, box, s.drag.dx, s.drag.dy);
    }
  } catch {
    // Non-fatal: a missing control just means we skip that beat of the tour.
  }
}

// Generic tour: sweep the cursor, scroll top -> bottom -> top, hover controls.
async function defaultTour(page, budgetMs) {
  const start = Date.now();
  const remaining = () => budgetMs - (Date.now() - start);
  await page.mouse.move(VIEW.width * 0.3, VIEW.height * 0.4).catch(() => {});
  await page.waitForTimeout(1200);

  const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)).catch(() => VIEW.height);
  const viewport = VIEW.height;
  const maxScroll = Math.max(0, height - viewport);
  const segments = 8;
  const scrollBudget = Math.max(4000, remaining() - 4000);
  for (let i = 1; i <= segments; i++) {
    if (remaining() < 2500) break;
    const y = Math.round((maxScroll * i) / segments);
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "smooth" }), y).catch(() => {});
    await page.mouse.move(VIEW.width * (0.25 + 0.5 * ((i % 3) / 2)), VIEW.height * (0.35 + 0.3 * ((i % 2)))).catch(() => {});
    await page.locator("button, [role=button], a").first().hover({ timeout: 800 }).catch(() => {});
    await page.waitForTimeout(Math.max(600, Math.round(scrollBudget / segments)));
  }
  // Back to the top for a clean finish.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })).catch(() => {});
  const tail = remaining();
  if (tail > 0) await page.waitForTimeout(tail);
}

async function runScript(page, project, budgetMs) {
  const steps = STEPS[project.key];
  if (!steps) return defaultTour(page, budgetMs);
  const start = Date.now();
  for (const s of steps) {
    if (Date.now() - start > budgetMs - 1500) break;
    await doStep(page, s);
  }
  const remaining = budgetMs - (Date.now() - start);
  if (remaining > 0) await page.waitForTimeout(remaining);
}

/* ------------------------------------------------------------------ */
/* Capture                                                            */
/* ------------------------------------------------------------------ */

async function recordDemo(browser, project, tmp, budgetMs) {
  const key = project.key;
  const videoDir = path.join(tmp, key);
  await mkdir(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    recordVideo: { dir: videoDir, size: VIEW },
  });

  let rawVideo = null;
  let posterMade = false;
  let error = null;

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    const video = page.video();
    const killer = setTimeout(() => page.close().catch(() => {}), PER_PROJECT_TIMEOUT);
    try {
      const url = (project.demos && project.demos[0] && project.demos[0].url) || project.live_url;
      try {
        await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
      } catch {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      }
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      await runScript(page, project, budgetMs);

      // Poster frame, taken during the demo.
      const posterPng = path.join(videoDir, `${key}.poster.png`);
      await page.screenshot({ path: posterPng, timeout: 15000 }).catch(() => {});
      if (existsSync(posterPng)) {
        await sharpToWebp(posterPng, path.join(PREVIEWS_DIR, `${key}.webp`));
        posterMade = existsSync(path.join(PREVIEWS_DIR, `${key}.webp`));
        await rm(posterPng, { force: true });
      }
    } finally {
      clearTimeout(killer);
    }

    await context.close();
    rawVideo = video ? await video.path() : null;
  } catch (err) {
    error = err;
    await context.close().catch(() => {});
  }

  return { rawVideo, posterMade, error, videoDir };
}

// sharp is optional here (only used for the poster); fail soft if absent.
async function sharpToWebp(src, dest) {
  try {
    const sharp = (await import("sharp")).default;
    await sharp(src).resize(OUT.width, OUT.height, { fit: "cover", position: "attention" })
      .webp({ quality: 74, effort: 5 }).toFile(dest);
  } catch {
    // no sharp: leave the previous poster in place
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const getOpt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const msIdx = argv.indexOf("--ms");
  const budgetMs = msIdx >= 0 ? Number(argv[msIdx + 1]) : DEFAULT_MS;
  const category = getOpt("--category");
  const keysOpt = getOpt("--keys");
  const keys = keysOpt ? keysOpt.split(/[\s,]+/).filter(Boolean) : null;

  await mkdir(PREVIEWS_DIR, { recursive: true });
  const data = JSON.parse(await readFile(PROJECTS, "utf8"));
  const targets = data.projects.filter((p) => {
    if (!(p.has_live_demo && p.live_url)) return false;
    if (category && p.category !== category) return false;
    if (keys && !keys.includes(p.key)) return false;
    return true;
  });
  if (!targets.length) {
    console.error("no matching live projects to record");
    process.exit(1);
  }

  let manifest = { generated_at: new Date().toISOString(), previews: {} };
  if (existsSync(MANIFEST)) {
    try { manifest = JSON.parse(await readFile(MANIFEST, "utf8")); manifest.previews ||= {}; } catch {}
  }

  const ffmpeg = await findFfmpeg();
  const browser = await launchBrowser();
  const tmp = path.join(os.tmpdir(), `livive-demos-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  const queue = [...targets];
  let ok = 0, failed = 0;
  const total = targets.length;
  const n = () => ok + failed;

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const key = p.key;
      const clipPath = path.join(PREVIEWS_DIR, `${key}.webm`);
      const { rawVideo, posterMade, error, videoDir } = await recordDemo(browser, p, tmp, budgetMs);
      try {
        if (error || !rawVideo || !existsSync(rawVideo)) throw error || new Error("no video produced");
        let out = rawVideo;
        let width = VIEW.width, height = VIEW.height;
        if (ffmpeg) {
          const small = path.join(videoDir, `${key}.small.webm`);
          const okFf = await run(ffmpeg, [
            "-y", "-i", rawVideo, "-an",
            "-c:v", "libvpx", "-b:v", "650k", "-crf", "34",
            "-vf", `scale=${OUT.width}:${OUT.height}`,
            small,
          ]);
          if (okFf && existsSync(small)) { out = small; width = OUT.width; height = OUT.height; }
        }
        await rm(clipPath, { force: true });
        await rename(out, clipPath);
        const sizeBytes = (await readFile(clipPath)).length;
        const prev = manifest.previews[key] || {};
        manifest.previews[key] = {
          ...prev,
          video: `previews/${key}.webm`,
          poster: posterMade ? `previews/${key}.webp` : (p.thumb || prev.poster || null),
          mode: "demo",
          duration_ms: budgetMs,
          width,
          height,
          bytes: sizeBytes,
          captured_at: new Date().toISOString(),
          source: (p.demos && p.demos[0] && p.demos[0].url) || p.live_url,
        };
        ok++;
        console.log(`ok [${n()}/${total}] ${key} (${(sizeBytes / 1024).toFixed(1)}KB)`);
      } catch (err) {
        failed++;
        console.log(`!! [${n()}/${total}] ${key} (${err.message || err})`);
      } finally {
        await rm(videoDir, { recursive: true, force: true });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, worker));
  await browser.close().catch(() => {});
  await rm(tmp, { recursive: true, force: true });

  manifest.generated_at = new Date().toISOString();
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\ndemo clips: ${ok} recorded, ${failed} failed (${budgetMs}ms each) -> previews/`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
