#!/usr/bin/env node
/*
 * Thumbnail capture pipeline for the livive.net landing page.
 *
 * For each project in projects.json:
 *   - live demo  -> Playwright screenshot of the live URL (1200x750 viewport)
 *   - repo only  -> GitHub's auto-generated social preview image
 *   - fallbacks  -> live capture falls back to the GitHub OG image
 * Output is normalized with sharp to 640px wide WebP at thumbnails/<key>.webp.
 * Every project emits WebP; legacy PNG/JPG siblings for a processed key are removed.
 *
 * Usage:  node _bootstrap/thumbs.mjs            (all projects)
 *         node _bootstrap/thumbs.mjs lokarta sm3 (subset by key)
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
const USER = "jpeckenpaugh";

const VIEW = { width: 1200, height: 750 };
const OUT_W = 640;
const QUALITY = 80;
const DEFAULT_WAIT = 4000;
const NAV_TIMEOUT = 20000;
const PER_PROJECT_TIMEOUT = 55000;
const CONCURRENCY = 3;

// Per-project settle delay overrides (ms) for slow boot sequences.
const WAIT_OVERRIDES = {
  "threat-sweep": 7000,
  "lk.livive.net": 5000,
};
// Per-project pre-shot click selectors (dismiss splash / start).
const CLICK_OVERRIDES = {};

function ogUrl(repo) {
  const name = Array.isArray(repo) ? repo[0] : repo;
  return `https://opengraph.githubassets.com/1/${USER}/${name}`;
}

async function download(url, dest, { retries = 4 } = {}) {
  let wait = 1200;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "livive-thumbs" } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      return dest;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = parseInt(res.headers.get("retry-after") || "0", 10);
      await new Promise((r) => setTimeout(r, ra ? ra * 1000 : wait));
      wait *= 2;
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("HTTP 429 (rate limited after retries)");
}

// Serialize GitHub OG requests with a minimum spacing to avoid rate limits.
const OG_MIN_INTERVAL = 1600;
let ogGate = Promise.resolve();
function ogDelay() {
  ogGate = ogGate.then(() => new Promise((r) => setTimeout(r, OG_MIN_INTERVAL)));
  return ogGate;
}

async function fetchOg(repo, dest) {
  await ogDelay();
  return download(ogUrl(repo), dest);
}

async function captureLive(page, project) {
  const key = project.key;
  const wait = project.thumb_wait ?? WAIT_OVERRIDES[key] ?? DEFAULT_WAIT;
  try {
    await page.goto(project.live_url, { waitUntil: "load", timeout: NAV_TIMEOUT });
  } catch {
    await page.goto(project.live_url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
  }
  const sel = CLICK_OVERRIDES[key];
  if (sel) await page.click(sel, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(wait);
}

async function toWebp(src, dest) {
  await sharp(src)
    .resize({ width: OUT_W, withoutEnlargement: true })
    .webp({ quality: QUALITY, effort: 6 })
    .toFile(dest);
}

async function main() {
  const only = process.argv.slice(2);
  await mkdir(THUMBS, { recursive: true });
  const data = JSON.parse(await readFile(PROJECTS, "utf8"));
  const projects = data.projects.filter((p) => !only.length || only.includes(p.key));

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const tmp = os.tmpdir();

  const queue = [...projects];
  const usedThumb = new Map();
  let ok = 0;
  const total = projects.length;

  async function finish(key, rawPath) {
    const finalName = `${key}.webp`;
    const finalPath = path.join(THUMBS, finalName);
    await toWebp(rawPath, finalPath);
    usedThumb.set(key, `thumbnails/${finalName}`);
    // Normalize: drop any legacy non-WebP sibling so the repo stays all-WebP.
    await Promise.all(
      ["png", "jpg", "jpeg"].map((ext) => rm(path.join(THUMBS, `${key}.${ext}`), { force: true })),
    );
  }

  function report(line, good) {
    if (good) ok++;
    console.log(`${good ? "ok " : "!! "} [${String(ok).padStart(2)}/${total}] ${line}`);
  }

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const key = p.key;
      const raw = path.join(tmp, `livive-${key}.png`);
      try {
        if (p.has_live_demo) {
          const page = await context.newPage();
          page.setDefaultTimeout(NAV_TIMEOUT);
          const killer = setTimeout(() => page.close().catch(() => {}), PER_PROJECT_TIMEOUT);
          try {
            await captureLive(page, p);
            await page.screenshot({ path: raw, timeout: 15000 });
            await finish(key, raw);
            report(`${key} (live) -> ${usedThumb.get(key)}`, true);
          } finally {
            clearTimeout(killer);
            await page.close().catch(() => {});
          }
        } else {
          await fetchOg(p.repo, raw);
          await finish(key, raw);
          report(`${key} (og) -> ${usedThumb.get(key)}`, true);
        }
      } catch (err) {
        // fallback: if a live capture failed, try the GitHub OG image
        if (p.has_live_demo) {
          try {
            await fetchOg(p.repo, raw);
            await finish(key, raw);
            report(`${key} (og fallback: ${err.message})`, true);
            continue;
          } catch (e2) {
            err = e2;
          }
        }
        report(`${key}: ${err.message}`, false);
      } finally {
        await rm(raw, { force: true });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  // Record resolved thumbnails back into projects.json (merge.py also does this).
  for (const p of data.projects) {
    p.thumb = usedThumb.get(p.key) ?? null;
  }
  await writeFile(PROJECTS, JSON.stringify(data, null, 2) + "\n");

  console.log(`\n${ok}/${total} thumbnails written to thumbnails/`);
  if (ok < total) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
