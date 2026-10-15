#!/usr/bin/env node
/*
 * Thumbnail capture pipeline for the livive.net landing page.
 *
 * For every project in projects.json we emit exactly one canonical asset:
 *   thumbnails/<key>.webp  — 16:10 (1.600), opaque, <= 60 KB, <= 1280px wide.
 *
 *   - live demo  -> Playwright screenshot of the hero UI at 1600x1000 (16:10)
 *   - repo only  -> a purpose-built 16:10 branded placeholder (never a GitHub OG card)
 *   - fallbacks  -> a live capture that fails degrades to the branded placeholder
 *
 * Every source is cover-cropped to 16:10 so a differently-shaped source can
 * never letterbox inside the card frame. Legacy PNG/JPG siblings are removed.
 *
 * Art direction: see the `thumbnail-art-direction` document on AIA-6.
 *
 * Usage:  node _bootstrap/thumbs.mjs            (all projects)
 *         node _bootstrap/thumbs.mjs lokarta sm3 (subset by key)
 *         node _bootstrap/thumbs.mjs --placeholders (repo-only branded cards)
 */

import { chromium } from "playwright-core";
import sharp from "sharp";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BOOT, "..");
const PROJECTS = path.join(ROOT, "projects.json");
const THUMBS = path.join(ROOT, "thumbnails");

// Master capture is 1600x1000 (16:10); exports are downscaled to the card grid.
const VIEW = { width: 1600, height: 1000 };
const DPR = 2; // retina master, downscaled on export
const OUT_W = 1280;
const OUT_H = 800; // 16:10
const MIN_W = 640;
const MIN_H = 400;
const QUALITY = 80;
const TARGET_BYTES = 40 * 1024; // art-direction target
const CAP_BYTES = 60 * 1024; // hard acceptance cap
const DEFAULT_WAIT = 3500; // ready-signal floor after load
const NAV_TIMEOUT = 30000;
const PER_PROJECT_TIMEOUT = 80000;
const CONCURRENCY = 3;

// Optional Chromium executable (CI/sandboxes without the bundled download).
const CHROME_EXECUTABLE =
  process.env.LIVIVE_CHROME ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  null;

// Per-project settle floor (ms) for slow boot sequences.
const WAIT_OVERRIDES = {
  "threat-sweep": 6000,
  "lk.livive.net": 5000,
  aom: 2500, // extra beat after the game boots before the title screen settles
};

// Per-project readiness gates: wait for a real "product is up" signal instead
// of a blind timeout. Falls back to network-idle when no gate is listed.
const READY_OVERRIDES = {
  aom: async (page) =>
    page
      .waitForFunction(() => /Age of Mycology/i.test(document.title), {
        timeout: 45000,
      })
      .catch(() => {}),
  // "Checking for published build..." spinner until the dataset resolves.
  "c3pa-explorer": async (page) =>
    page
      .waitForFunction(
        () =>
          !/Checking for publish/i.test(document.body.innerText) &&
          document.body.innerText.length > 500,
        { timeout: 25000 },
      )
      .catch(() => {}),
};

// Per-project pre-shot click selectors (dismiss splash / start screens).
const CLICK_OVERRIDES = {};

// Per-project element selectors: screenshot the hero element (the largest
// match) instead of the raw viewport, so text-wall pages frame a visual.
const SELECTOR_OVERRIDES = {
  sm3: "img",
  aom: "canvas",
};

function initials(s) {
  return (
    (String(s).match(/[A-Za-z0-9]+/g) || [])
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function hue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

async function launchBrowser() {
  const opts = { headless: true };
  if (CHROME_EXECUTABLE) opts.executablePath = CHROME_EXECUTABLE;
  else opts.channel = "chrome";
  return chromium.launch(opts);
}

// Freeze motion and scroll before the shot so captures are deterministic.
async function freezeMotion(page) {
  await page
    .addStyleTag({
      content: `*{scroll-behavior:auto!important}
        *,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
        ::-webkit-scrollbar{display:none!important}`,
    })
    .catch(() => {});
}

async function captureLive(page, project) {
  const key = project.key;
  const wait = project.thumb_wait ?? WAIT_OVERRIDES[key] ?? DEFAULT_WAIT;

  try {
    await page.goto(project.live_url, { waitUntil: "load", timeout: NAV_TIMEOUT });
  } catch {
    await page
      .goto(project.live_url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })
      .catch(() => {});
  }

  // Ready signal: a per-project gate when known, otherwise network-idle.
  const ready = READY_OVERRIDES[key];
  if (ready) {
    await ready(page);
  } else {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  }

  const click = CLICK_OVERRIDES[key] || project.thumb_click;
  if (click) await page.click(click, { timeout: 3000 }).catch(() => {});

  await freezeMotion(page);
  await page.waitForTimeout(wait);
}

// Screenshot the hero element's largest match, else the full viewport.
async function shoot(page, project, raw) {
  const sel = SELECTOR_OVERRIDES[project.key];
  if (sel) {
    const handle = await page
      .evaluateHandle((s) => {
        const els = [...document.querySelectorAll(s)];
        let best = null;
        let bestArea = 0;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          const shown = r.width >= 80 && r.height >= 60;
          if (shown && area > bestArea) {
            bestArea = area;
            best = el;
          }
        }
        return best;
      }, sel)
      .catch(() => null);
    const element = handle && handle.asElement();
    if (element) {
      await element.screenshot({ path: raw }).catch(() => {});
      await handle.dispose().catch(() => {});
      return true;
    }
  }
  await page.screenshot({ path: raw, timeout: 15000 });
  return true;
}

/* ------------------------------------------------------------------ */
/* Branded placeholder (repo-only projects)                            */
/* ------------------------------------------------------------------ */

function placeholderHtml(project) {
  const h = hue(project.key);
  const h2 = (h + 42) % 360;
  const ini = initials(project.display_title || project.key);
  const cat = project.category || "Project";
  const title = project.display_title || project.key;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    .ph{width:${VIEW.width}px;height:${VIEW.height}px;position:relative;overflow:hidden;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;
      color:#fff;font-family:system-ui,-apple-system,'DejaVu Sans',Arial,sans-serif;
      background:
        radial-gradient(1100px 620px at 50% -12%, hsl(${h} 62% 30%) 0%, transparent 62%),
        linear-gradient(138deg, hsl(${h} 46% 17%), hsl(${h2} 54% 9%));}
    .ph:before{content:"";position:absolute;inset:0;opacity:.35;
      background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),
        linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);
      background-size:80px 80px,80px 80px;}
    .brand{position:absolute;top:54px;left:64px;font-size:24px;font-weight:800;letter-spacing:.2em;
      color:rgba(255,255,255,.9)}
    .brand span{font-weight:600;color:rgba(255,255,255,.55);letter-spacing:.28em}
    .mark{width:196px;height:196px;border-radius:34px;display:grid;place-items:center;
      font-size:88px;font-weight:800;letter-spacing:.02em;color:#fff;
      background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.24);
      box-shadow:0 20px 70px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18)}
    .title{font-size:60px;font-weight:800;letter-spacing:-.01em;text-align:center;
      max-width:1240px;line-height:1.08;color:#fff;text-shadow:0 2px 20px rgba(0,0,0,.35)}
    .cat{font-size:21px;font-weight:600;letter-spacing:.26em;text-transform:uppercase;
      color:rgba(255,255,255,.72)}
    .bar{position:absolute;left:0;right:0;bottom:0;height:10px;
      background:linear-gradient(90deg,hsl(${h} 72% 56%),hsl(${h2} 72% 46%))}
  </style></head><body>
    <div class="ph">
      <div class="brand">LIVIVE.NET <span>STUDIOS</span></div>
      <div class="mark">${escHtml(ini)}</div>
      <div class="title">${escHtml(title)}</div>
      <div class="cat">${escHtml(cat)}</div>
      <div class="bar"></div>
    </div>
  </body></html>`;
}

async function capturePlaceholder(page, project, raw) {
  await page.setViewportSize(VIEW);
  await page.setContent(placeholderHtml(project), { waitUntil: "load" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: raw, timeout: 15000 });
}

/* ------------------------------------------------------------------ */
/* Encode: force 16:10, bound the file size                            */
/* ------------------------------------------------------------------ */

async function toWebp(src, dest) {
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height) throw new Error("unreadable source image");

  let width = OUT_W;
  let height = OUT_H;
  let quality = QUALITY;
  let buf;

  for (;;) {
    buf = await sharp(src)
      .resize(width, height, { fit: "cover", position: "attention" })
      .webp({ quality, effort: 6 })
      .toBuffer();

    if (buf.length <= TARGET_BYTES) break;
    if (quality > 45) {
      quality -= 8;
      continue;
    }
    if (width > MIN_W) {
      width = Math.max(MIN_W, Math.round(width * 0.8));
      height = Math.round((width * 10) / 16);
      quality = QUALITY;
      continue;
    }
    break; // at the floor: accept whatever we have
  }

  await writeFile(dest, buf);
  return { bytes: buf.length, width, height };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const placeholdersOnly = args.includes("--placeholders");
  const only = args.filter((a) => !a.startsWith("--"));

  await mkdir(THUMBS, { recursive: true });
  const data = JSON.parse(await readFile(PROJECTS, "utf8"));
  const projects = data.projects.filter((p) => {
    if (only.length && !only.includes(p.key)) return false;
    if (placeholdersOnly && p.has_live_demo) return false;
    return true;
  });

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: DPR,
    ignoreHTTPSErrors: true,
  });
  const tmp = os.tmpdir();

  const queue = [...projects];
  let ok = 0;
  let failed = 0;
  const total = projects.length;
  const results = [];

  function report(key, source, size, good, note) {
    if (good) ok++;
    else failed++;
    const tag = good ? "ok " : "!! ";
    const dims = size ? `${size.width}x${size.height}` : "-";
    const kb = size ? `${(size.bytes / 1024).toFixed(1)}KB` : "-";
    console.log(
      `${tag}[${String(ok + failed).padStart(2)}/${total}] ${key} (${source}) ${dims} ${kb}${note ? " " + note : ""}`,
    );
    results.push({ key, source, good, ...size, note });
  }

  async function finish(key, raw) {
    const finalName = `${key}.webp`;
    const finalPath = path.join(THUMBS, finalName);
    const size = await toWebp(raw, finalPath);
    if (size.bytes > CAP_BYTES) throw new Error(`over cap: ${(size.bytes / 1024).toFixed(1)}KB`);
    // Normalize: drop any legacy non-WebP sibling so the repo stays all-WebP.
    await Promise.all(
      ["png", "jpg", "jpeg"].map((ext) => rm(path.join(THUMBS, `${key}.${ext}`), { force: true })),
    );
    return size;
  }

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const key = p.key;
      const raw = path.join(tmp, `livive-${key}.png`);
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT);
      const killer = setTimeout(() => page.close().catch(() => {}), PER_PROJECT_TIMEOUT);
      try {
        if (p.has_live_demo && p.live_url && !placeholdersOnly) {
          try {
            await captureLive(page, p);
            await shoot(page, p, raw);
            const size = await finish(key, raw);
            report(key, "live", size, true);
          } catch (err) {
            // Degrade to the branded placeholder — never a GitHub OG card.
            await capturePlaceholder(page, p, raw);
            const size = await finish(key, raw);
            report(key, "placeholder", size, true, `(live failed: ${err.message})`);
          }
        } else {
          await capturePlaceholder(page, p, raw);
          const size = await finish(key, raw);
          report(key, "placeholder", size, true);
        }
      } catch (err) {
        report(key, "error", null, false, err.message);
      } finally {
        clearTimeout(killer);
        await page.close().catch(() => {});
        await rm(raw, { force: true });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  console.log(`\n${ok}/${total} thumbnails written to thumbnails/ (${failed} failed)`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
