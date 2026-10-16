#!/usr/bin/env node
/*
 * Preview-clip capture pipeline for the livive.net catalogue.
 *
 * Every live demo gets a short, muted "preview" clip, Netflix-style:
 *
 *   previews/<key>.webm  — short silent clip (~4-6s), 16:10
 *   previews.json        — manifest keyed by project key
 *
 * Two capture strategies, chosen automatically:
 *   1. Real capture: Playwright records the live site loading + a first scroll,
 *      then the clip is transcoded down to a light vp8 webm. This is the ideal
 *      output and is used whenever a Chromium can launch (CI / owner machine).
 *   2. Motion fallback: when no browser is available (bare sandbox), the
 *      project thumbnail is animated into a subtle Ken-Burns "loading" clip
 *      with sharp + the bundled Playwright ffmpeg, so the catalogue still has
 *      real video previews. The poster stays the existing thumbnail.
 *
 * Failing captures are skipped, never fatal, so the pipeline can run
 * incrementally and re-run for a single key.
 *
 * Usage:  node _bootstrap/previews.mjs                (all live projects)
 *         node _bootstrap/previews.mjs aom lokarta    (subset by key)
 *         node _bootstrap/previews.mjs --featured     (featured only)
 *         node _bootstrap/previews.mjs --force        (re-record existing)
 *         node _bootstrap/previews.mjs --motion       (force the fallback)
 */

import sharp from "sharp";
import { mkdir, readFile, writeFile, rm, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const BOOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BOOT, "..");
const PROJECTS = path.join(ROOT, "projects.json");
const PREVIEWS_DIR = path.join(ROOT, "previews");
const MANIFEST = path.join(ROOT, "previews.json");

const VIEW = { width: 800, height: 500 };
const OUT = { width: 640, height: 400 };
const FPS = 15;
const FRAMES = Number(process.env.LIVIVE_PREVIEW_FRAMES || 66); // ~4.4s @ 15fps
const DURATION_MS = Math.round((FRAMES / FPS) * 1000);
const NAV_TIMEOUT = 30000;
const PER_PROJECT_TIMEOUT = 75000;
const CONCURRENCY = Number(process.env.LIVIVE_PREVIEW_CONCURRENCY || 3);
const POSTER_W = 960;
const POSTER_H = 600;

const CHROME_EXECUTABLE =
  process.env.LIVIVE_CHROME ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  null;

const WAIT_OVERRIDES = {
  "threat-sweep": 2500,
  "c3pa-explorer": 4000,
  aom: 2000,
  "rl-livive-net": 2000,
};
const CLICK_OVERRIDES = {};

async function loadChromium() {
  try {
    const mod = await import("playwright-core");
    return mod.chromium;
  } catch {
    return null;
  }
}

async function launchBrowser() {
  const chromium = await loadChromium();
  if (!chromium) return null;
  const opts = { headless: true };
  if (CHROME_EXECUTABLE) opts.executablePath = CHROME_EXECUTABLE;
  try {
    return await chromium.launch(opts);
  } catch (err) {
    console.warn(`[previews] browser unavailable, using motion fallback: ${String(err.message).split("\n")[0]}`);
    return null;
  }
}

async function findFfmpeg() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return null;
  const dirs = await readdir(base).catch(() => []);
  for (const d of dirs) {
    if (!d.startsWith("ffmpeg-")) continue;
    for (const name of ["ffmpeg-linux", "ffmpeg"]) {
      const p = path.join(base, d, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (err) => resolve(!err)));

const posterPathFor = (key) => path.join(PREVIEWS_DIR, `${key}.webp`);
const videoPathFor = (key) => path.join(PREVIEWS_DIR, `${key}.webm`);

/* ------------------------------------------------------------------ */
/* Real capture                                                        */
/* ------------------------------------------------------------------ */

async function recordClip(browser, project, tmp) {
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
      try {
        await page.goto(project.live_url, { waitUntil: "load", timeout: NAV_TIMEOUT });
      } catch {
        await page.goto(project.live_url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      }
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

      const click = CLICK_OVERRIDES[key] || project.preview_click;
      if (click) await page.click(click, { timeout: 2500 }).catch(() => {});

      await page.waitForTimeout(WAIT_OVERRIDES[key] ?? 1200);
      await page.mouse.move(VIEW.width / 2, VIEW.height / 2).catch(() => {});
      await page.mouse.wheel(0, 220).catch(() => {});
      await page.waitForTimeout(Math.max(900, DURATION_MS - 1400));
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })).catch(() => {});

      const posterPng = path.join(videoDir, `${key}.poster.png`);
      await page.screenshot({ path: posterPng, timeout: 12000 }).catch(() => {});
      if (existsSync(posterPng)) {
        await sharp(posterPng)
          .resize(POSTER_W, POSTER_H, { fit: "cover", position: "attention" })
          .webp({ quality: 74, effort: 5 })
          .toFile(posterPathFor(key))
          .catch(() => {});
        posterMade = existsSync(posterPathFor(key));
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

/* ------------------------------------------------------------------ */
/* Motion fallback (thumbnail -> clip)                                 */
/* ------------------------------------------------------------------ */

async function makeMotionClip(thumbRel, outPath, ffmpeg) {
  const src = path.join(ROOT, thumbRel);
  if (!existsSync(src)) throw new Error("no thumbnail for motion fallback");
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height) throw new Error("unreadable thumbnail");

  const args = [
    "-y",
    "-f", "image2pipe", "-framerate", String(FPS), "-vcodec", "mjpeg", "-i", "pipe:0",
    "-an",
    "-c:v", "libvpx", "-b:v", "260k", "-crf", "36",
    "-pix_fmt", "yuv420p",
    "-s", `${OUT.width}x${OUT.height}`,
    outPath,
  ];
  const proc = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "ignore"] });
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code))));
  });

  const write = (buf) =>
    new Promise((resolve, reject) =>
      proc.stdin.write(buf, (e) => (e ? reject(e) : resolve())));

  for (let i = 0; i < FRAMES; i++) {
    const t = i / (FRAMES - 1);
    const zoom = 1.0 + 0.14 * t; // slow push-in
    const cw = Math.max(2, Math.round(meta.width / zoom));
    const ch = Math.max(2, Math.round(meta.height / zoom));
    const driftX = Math.round((meta.width - cw) * (0.5 + 0.16 * Math.sin(t * Math.PI * 2)));
    const driftY = Math.round((meta.height - ch) * (0.5 - 0.10 * Math.cos(t * Math.PI * 2)));
    const left = Math.min(Math.max(0, driftX), meta.width - cw);
    const top = Math.min(Math.max(0, driftY), meta.height - ch);
    const frame = await sharp(src)
      .extract({ left, top, width: cw, height: ch })
      .resize(OUT.width, OUT.height)
      .jpeg({ quality: 82, chromaSubsampling: "4:2:0" })
      .toBuffer();
    await write(frame);
  }
  proc.stdin.end();
  await done;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const featuredOnly = args.includes("--featured");
  const force = args.includes("--force");
  const motionOnly = args.includes("--motion");
  const only = args.filter((a) => !a.startsWith("--"));

  await mkdir(PREVIEWS_DIR, { recursive: true });
  const data = JSON.parse(await readFile(PROJECTS, "utf8"));
  const live = data.projects.filter((p) => {
    if (!(p.has_live_demo && p.live_url)) return false;
    if (only.length && !only.includes(p.key)) return false;
    if (featuredOnly && !p.featured) return false;
    return true;
  });

  let manifest = { generated_at: new Date().toISOString(), previews: {} };
  if (existsSync(MANIFEST)) {
    try {
      manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
      manifest.previews ||= {};
    } catch {}
  }

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    console.error("no ffmpeg found; cannot encode previews");
    process.exit(1);
  }
  const browser = motionOnly ? null : await launchBrowser();
  const tmp = path.join(os.tmpdir(), `livive-previews-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  const queue = [...live];
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const total = live.length;
  const n = () => ok + skipped + failed;

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const key = p.key;
      const clipPath = videoPathFor(key);

      if (!force && existsSync(clipPath)) {
        skipped++;
        console.log(`== [${n()}/${total}] ${key} (already recorded)`);
        continue;
      }

      let mode = "motion";
      let poster = p.thumb || null;
      let width = OUT.width;
      let height = OUT.height;
      let videoDir = null;

      try {
        if (browser) {
          const rec = await recordClip(browser, p, tmp);
          videoDir = rec.videoDir;
          if (!rec.error && rec.rawVideo && existsSync(rec.rawVideo)) {
            const transcoded = path.join(rec.videoDir, `${key}.small.webm`);
            const okFf = await run(ffmpeg, [
              "-y", "-i", rec.rawVideo, "-an",
              "-c:v", "libvpx", "-b:v", "300k", "-crf", "38",
              "-vf", `scale=${OUT.width}:${OUT.height}`,
              transcoded,
            ]);
            await rm(clipPath, { force: true });
            if (okFf && existsSync(transcoded)) await rename(transcoded, clipPath);
            else await rename(rec.rawVideo, clipPath);
            if (rec.posterMade) poster = `previews/${key}.webp`;
            width = OUT.width;
            height = OUT.height;
            mode = "live";
          }
        }

        if (mode === "motion") {
          if (!p.thumb) throw new Error("no thumbnail and no browser");
          await makeMotionClip(p.thumb, clipPath, ffmpeg);
        }

        const sizeBytes = (await readFile(clipPath)).length;
        manifest.previews[key] = {
          video: `previews/${key}.webm`,
          poster,
          mode,
          duration_ms: DURATION_MS,
          width,
          height,
          bytes: sizeBytes,
          captured_at: new Date().toISOString(),
          source: p.live_url,
        };
        ok++;
        console.log(`ok [${n()}/${total}] ${key} (${mode}, ${(sizeBytes / 1024).toFixed(1)}KB)`);
      } catch (err) {
        failed++;
        console.log(`!! [${n()}/${total}] ${key} (${err.message || err})`);
      } finally {
        if (videoDir) await rm(videoDir, { recursive: true, force: true });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, worker),
  );
  if (browser) await browser.close().catch(() => {});
  await rm(tmp, { recursive: true, force: true });

  manifest.generated_at = new Date().toISOString();
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\npreviews: ${ok} recorded, ${skipped} present, ${failed} failed -> previews/`);
  if (!ok && !skipped) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
