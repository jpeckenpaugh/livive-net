#!/usr/bin/env node
/*
 * Fold per-repo showcase bundles into the Livive catalogue.
 *
 * Each project repo publishes demos/latest/manifest.json via its showcase.yml.
 * This script updates previews.json + thumbnails/ so build_site.mjs can render
 * the 30s demo, poster, and labeled gallery.
 *
 * Usage (from livive-net):
 *   node _bootstrap/sync-showcase.mjs                    # local sibling repos
 *   node _bootstrap/sync-showcase.mjs --raw              # raw.githubusercontent URLs
 *   node _bootstrap/sync-showcase.mjs --keys trot-livive-net fourcast-livive-net
 *   node _bootstrap/sync-showcase.mjs --raw --keys yds-livive-net
 *
 * Local mode is for staging before the project repos are pushed. Raw mode is
 * for the published site and only needs the manifest + thumb.webp.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NETFIX = path.resolve(ROOT, "..");
const MANIFEST = path.join(ROOT, "previews.json");
const PROJECTS = path.join(ROOT, "projects.json");
const THUMBS = path.join(ROOT, "thumbnails");
const PREVIEWS = path.join(ROOT, "previews");

const args = new Set(process.argv.slice(2));
const raw = args.has("--raw");
const keyArg = process.argv.indexOf("--keys");
const keys = keyArg >= 0 ? process.argv.slice(keyArg + 1).filter((a) => !a.startsWith("--")) : null;
const RAW_BASE = "https://raw.githubusercontent.com/jpeckenpaugh";

const projects = JSON.parse(fs.readFileSync(PROJECTS, "utf8")).projects;
const previews = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
previews.previews ||= {};

function rawUrl(repo, rel) {
  return `${RAW_BASE}/${repo}/main/demos/latest/${rel.replace(/^\/+/, "")}`;
}

async function readManifest(repo, key) {
  const localDir = path.join(NETFIX, repo, "demos", "latest");
  const localManifest = path.join(localDir, "manifest.json");
  if (fs.existsSync(localManifest)) {
    return { manifest: JSON.parse(await fsp.readFile(localManifest, "utf8")), localDir };
  }
  const url = rawUrl(repo, "manifest.json");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${key}: manifest ${res.status} at ${url}`);
  return { manifest: await res.json(), localDir: null };
}

async function copy(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function syncOne(project) {
  const key = project.key;
  const repo = project.repo;
  if (!repo) return null;
  const { manifest, localDir } = await readManifest(repo, key);
  const relVideo = manifest.video || "demo.webm";
  const relPoster = manifest.poster || "poster.webp";
  const gallery = (manifest.gallery || []).map((g) => ({ label: g.label, src: g.src }));

  const entry = {
    mode: "demo",
    duration_ms: manifest.duration_ms || 30000,
    width: manifest.viewport?.width || 1280,
    height: manifest.viewport?.height || 800,
    bytes: manifest.video_bytes || undefined,
    captured_at: new Date().toISOString(),
    source: project.live_url,
    gallery: [],
  };

  if (raw) {
    entry.video = rawUrl(repo, relVideo);
    entry.poster = rawUrl(repo, relPoster);
    entry.gallery = gallery.map((g) => ({ label: g.label, src: rawUrl(repo, g.src) }));
    const thumbUrl = rawUrl(repo, "thumb.webp");
    await download(thumbUrl, path.join(THUMBS, `${key}.webp`));
    await download(thumbUrl, path.join(NETFIX, "thumbnails", `${key}.webp`));
    await download(thumbUrl, path.join(NETFIX, "beta-livive-net", "thumbnails", `${key}.webp`));
  } else {
    if (!localDir) throw new Error(`${key}: local demos/latest not found; use --raw`);
    entry.video = `previews/${key}.webm`;
    entry.poster = `previews/${key}.webp`;
    entry.gallery = gallery.map((g) => ({ label: g.label, src: `previews/${key}/${path.basename(g.src)}` }));

    const localGallery = path.join(localDir, "gallery");
    const destGallery = path.join(PREVIEWS, key);
    await fsp.rm(destGallery, { recursive: true, force: true });
    await fsp.mkdir(destGallery, { recursive: true });
    for (const g of gallery) {
      const src = path.join(localDir, g.src);
      const name = path.basename(g.src);
      if (fs.existsSync(src)) await copy(src, path.join(destGallery, name));
    }

    await copy(path.join(localDir, relVideo), path.join(PREVIEWS, `${key}.webm`));
    await copy(path.join(localDir, relPoster), path.join(PREVIEWS, `${key}.webp`));
    await copy(path.join(localDir, "thumb.webp"), path.join(THUMBS, `${key}.webp`));

    // Keep the netfix root/beta mirrors in step for local staging.
    await copy(path.join(localDir, relVideo), path.join(NETFIX, "previews", `${key}.webm`));
    await copy(path.join(localDir, relPoster), path.join(NETFIX, "previews", `${key}.webp`));
    await copy(path.join(localDir, "thumb.webp"), path.join(NETFIX, "thumbnails", `${key}.webp`));
    await copy(path.join(localDir, relVideo), path.join(NETFIX, "beta-livive-net", "previews", `${key}.webm`));
    await copy(path.join(localDir, relPoster), path.join(NETFIX, "beta-livive-net", "previews", `${key}.webp`));
    await copy(path.join(localDir, "thumb.webp"), path.join(NETFIX, "beta-livive-net", "thumbnails", `${key}.webp`));
    for (const g of gallery) {
      const name = path.basename(g.src);
      const src = path.join(localDir, g.src);
      if (!fs.existsSync(src)) continue;
      await copy(src, path.join(NETFIX, "previews", key, name));
      await copy(src, path.join(NETFIX, "beta-livive-net", "previews", key, name));
    }
  }

  previews.previews[key] = entry;
  const mode = raw ? "raw" : "local";
  console.log(`ok ${key.padEnd(22)} ${mode}  ${gallery.length} stills  ${entry.duration_ms}ms`);
  return key;
}

async function main() {
  const targets = projects.filter((p) => (keys ? keys.includes(p.key) : true));
  const done = [];
  for (const project of targets) {
    if (!project.repo) continue;
    const localManifest = path.join(NETFIX, project.repo, "demos", "latest", "manifest.json");
    if (!keys && !raw && !fs.existsSync(localManifest)) continue;
    try {
      const key = await syncOne(project);
      if (key) done.push(key);
    } catch (err) {
      console.warn(`!! ${project.key}: ${err.message}`);
    }
  }
  previews.generated_at = new Date().toISOString();
  const body = JSON.stringify(previews, null, 2) + "\n";
  await fsp.writeFile(MANIFEST, body);
  await fsp.writeFile(path.join(NETFIX, "previews.json"), body);
  await fsp.writeFile(path.join(NETFIX, "beta-livive-net", "previews.json"), body);
  console.log(`updated previews.json (${done.length} showcase bundles)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
