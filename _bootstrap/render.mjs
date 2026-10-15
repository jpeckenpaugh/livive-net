#!/usr/bin/env node
/*
 * Static SEO renderer for the livive.net landing page.
 *
 * Reads projects.json and rewrites, in place:
 *   - index.html   -> prerendered project listing + JSON-LD (between markers)
 *   - sitemap.xml  -> crawlable URL list
 *   - robots.txt   -> crawl policy + sitemap pointer
 *
 * The prerendered markup mirrors the client-side renderer in index.html so a
 * no-JS fetch sees the same project titles, tags, and links that JS users do.
 *
 * Run after merge.py / thumbs.mjs:  node _bootstrap/render.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BOOT, "..");
const SITE = "https://www.livive.net";
const SITE_NAME = "Livive Projects";
const SITE_DESC =
  "Games, AI experiments, language tools, and prototypes — most of them playable right in your browser.";
const AUTHOR = { name: "Jarad Peckenpaugh", url: "https://github.com/jpeckenpaugh" };

const INDEX = path.join(ROOT, "index.html");
const SITEMAP = path.join(ROOT, "sitemap.xml");
const ROBOTS = path.join(ROOT, "robots.txt");

const MAIN_START = "<!-- projects:start -->";
const MAIN_END = "<!-- projects:end -->";
const JSONLD_START = "<!-- seo:jsonld:start -->";
const JSONLD_END = "<!-- seo:jsonld:end -->";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

const initials = (s) => (String(s).match(/[A-Za-z0-9]+/g) || [])
  .slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const hue = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

const EXT = ` target="_blank" rel="noopener noreferrer"`;
const projectHref = (p) => `#project=${encodeURIComponent(p.key)}`;
const primaryUrl = (p) => p.has_live_demo ? p.live_url : p.repo_url;

const thumbAlt = (p) => {
  const bits = [p.display_title];
  if (p.tagline) bits.push(p.tagline);
  else if (p.category) bits.push(p.category + " project");
  return esc(bits.join(" — ").slice(0, 240));
};

const thumbHtml = (p) => p.thumb
  ? `<div class="thumb"><img loading="lazy" src="${esc(p.thumb)}" alt="${thumbAlt(p)}" width="640" height="400"></div>`
  : `<div class="thumb ph" style="--h:${hue(p.key)}" aria-hidden="true">${esc(initials(p.display_title))}</div>`;

function statusChip(p) {
  const dot = p.has_live_demo ? `<span class="dot" aria-hidden="true"></span>` : "";
  const label = esc(p.status || "unknown");
  return `<span class="badge status" title="Status: ${label}">${dot}${label}</span>`;
}

function card(p) {
  const title = esc(p.display_title);
  const href = projectHref(p);
  const tags = (p.tags || []).slice(0, 5).map((t) => `<li>${esc(t)}</li>`).join("");
  const demos = (p.demos && p.demos.length) ? p.demos
    : (p.has_live_demo ? [{ label: "Play", url: p.live_url }] : []);
  const play = demos.map((dm) => `<a href="${esc(dm.url)}"${EXT}>${esc(dm.label)} &rarr;</a>`).join("");
  return `<article class="card">
      <a class="thumb-link" href="${href}" aria-label="View details for ${title}">${thumbHtml(p)}</a>
      <div class="body">
        <div class="top"><h3><a href="${href}">${title}</a></h3><div class="badges">${statusChip(p)}</div></div>
        <p class="tagline">${esc(p.tagline)}</p>
        ${tags ? `<ul class="tags">${tags}</ul>` : ""}
        <div class="links"><a class="details" href="${href}">Details</a>${play}<a href="${esc(p.repo_url)}"${EXT}>GitHub</a></div>
      </div>
    </article>`;
}

function listing(data) {
  return data.groups.map((g) => `  <section class="cat">
    <h2>${esc(g.category)} <span class="count">${g.projects.length}</span></h2>
    <div class="grid">${g.projects.map(card).join("")}</div>
  </section>`).join("\n");
}

function jsonLd(data) {
  const items = data.groups.flatMap((g) => g.projects).map((p, i) => ({
    "@type": "ListItem",
    position: i + 1,
    item: {
      "@type": "CreativeWork",
      name: p.display_title,
      description: p.tagline || p.short_description || undefined,
      url: primaryUrl(p),
      ...(p.thumb ? { image: `${SITE}/${p.thumb}` } : {}),
      ...(p.category ? { genre: p.category } : {}),
      ...(p.tech && p.tech.length ? { keywords: p.tech.join(", ") } : {}),
    },
  }));

  const doc = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE}/#website`,
        url: `${SITE}/`,
        name: SITE_NAME,
        description: SITE_DESC,
        inLanguage: "en",
        publisher: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
      },
      {
        "@type": "ItemList",
        "@id": `${SITE}/#projects`,
        name: "Livive projects",
        numberOfItems: items.length,
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        itemListElement: items,
      },
    ],
  };
  // Escape "</" so the payload can never close the <script> element.
  const json = JSON.stringify(doc, null, 2).replace(/<\//g, "<\\/");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

function replaceBetween(html, start, end, body) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`markers not found in index.html: ${start} / ${end}`);
  }
  return html.slice(0, a + start.length) + "\n" + body + "\n" + html.slice(b);
}

function sitemap(lastmod) {
  const entries = [`${SITE}/`].map((loc) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

const ROBOTS_TXT = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

async function main() {
  const data = JSON.parse(await readFile(path.join(ROOT, "projects.json"), "utf8"));
  const lastmod = (process.env.LIVIVE_LASTMOD || new Date().toISOString()).slice(0, 10);

  let html = await readFile(INDEX, "utf8");
  const before = html;
  html = replaceBetween(html, MAIN_START, MAIN_END, listing(data));
  html = replaceBetween(html, JSONLD_START, JSONLD_END, jsonLd(data));
  if (html !== before) await writeFile(INDEX, html);

  await writeFile(SITEMAP, sitemap(lastmod));
  await writeFile(ROBOTS, ROBOTS_TXT);

  console.log(`rendered ${data.projects.length} projects -> index.html, sitemap.xml, robots.txt`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
