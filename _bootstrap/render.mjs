#!/usr/bin/env node
/*
 * Static SEO renderer for livive.net.
 *
 * Reads projects.json and writes, in place:
 *   - index.html            -> prerendered project listing + JSON-LD (markers)
 *   - p/<key>/index.html    -> static per-project landing pages (OG + JSON-LD)
 *   - sitemap.xml           -> crawlable URL list (home + project pages)
 *   - robots.txt            -> crawl policy + sitemap pointer
 *
 * The prerendered listing links to the static per-project pages so non-JS
 * crawlers and social scrapers get real project content and per-project
 * Open Graph metadata. The client-side hash detail view in index.html remains
 * the interactive experience for JS users.
 *
 * Run after merge.py / thumbs.mjs:  node _bootstrap/render.mjs
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const PAGES = path.join(ROOT, "p");

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
const NEWTAB = `<span class="sr-only"> (opens in a new tab)</span>`;
const pageHref = (p) => `p/${encodeURIComponent(p.key)}/`;
const absPage = (p) => `${SITE}/${pageHref(p)}`;
const primaryUrl = (p) => p.has_live_demo ? p.live_url : p.repo_url;

const thumbAlt = (p) => {
  const bits = [p.display_title];
  if (p.tagline) bits.push(p.tagline);
  else if (p.category) bits.push(p.category + " project");
  return bits.join(" — ").slice(0, 240);
};

const thumbDims = (p) => (p.thumb_width && p.thumb_height)
  ? ` width="${Number(p.thumb_width)}" height="${Number(p.thumb_height)}"` : "";

const thumbHtml = (p) => p.thumb
  ? `<div class="thumb"><img loading="lazy" src="/${esc(p.thumb)}" alt="${esc(thumbAlt(p))}"${thumbDims(p)}></div>`
  : `<div class="thumb ph" style="--h:${hue(p.key)}" aria-hidden="true">${esc(initials(p.display_title))}</div>`;

function statusChip(p) {
  const dot = p.has_live_demo ? `<span class="dot" aria-hidden="true"></span>` : "";
  const label = esc(p.status || "unknown");
  return `<span class="badge status" title="Status: ${label}">${dot}${label}</span>`;
}

function demoLinks(p) {
  const demos = (p.demos && p.demos.length) ? p.demos
    : (p.has_live_demo ? [{ label: "Play", url: p.live_url }] : []);
  return demos.map((dm) => `<a href="${esc(dm.url)}"${EXT}>${esc(dm.label)} &rarr;${NEWTAB}</a>`).join("");
}

// ---- index listing card ----------------------------------------------------
function card(p) {
  const title = esc(p.display_title);
  const href = pageHref(p);
  const tags = (p.tags || []).slice(0, 5).map((t) => `<li>${esc(t)}</li>`).join("");
  return `<article class="card">
      <a class="thumb-link" href="${href}" aria-hidden="true" tabindex="-1">${thumbHtml(p)}</a>
      <div class="body">
        <div class="top"><h3><a href="${href}">${title}</a></h3><div class="badges">${statusChip(p)}</div></div>
        <p class="tagline">${esc(p.tagline)}</p>
        ${tags ? `<ul class="tags">${tags}</ul>` : ""}
        <div class="links"><a class="details" href="${href}">Details</a>${demoLinks(p)}<a href="${esc(p.repo_url)}"${EXT}>GitHub${NEWTAB}</a></div>
      </div>
    </article>`;
}

function listing(data) {
  return data.groups.map((g) => `  <section class="cat">
    <h2>${esc(g.category)} <span class="count">${g.projects.length}</span></h2>
    <div class="grid">${g.projects.map(card).join("")}</div>
  </section>`).join("\n");
}

// ---- index JSON-LD ---------------------------------------------------------
function indexJsonLd(data) {
  const items = data.groups.flatMap((g) => g.projects).map((p, i) => ({
    "@type": "ListItem",
    position: i + 1,
    item: {
      "@type": "CreativeWork",
      name: p.display_title,
      description: p.tagline || p.short_description || undefined,
      url: absPage(p),
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
  return ldScript(doc);
}

const ldScript = (doc) =>
  `<script type="application/ld+json">\n${JSON.stringify(doc, null, 2).replace(/<\//g, "<\\/")}\n</script>`;

// ---- per-project page ------------------------------------------------------
const PAGE_CSS = `
  :root{--bg:#f7f7f5;--fg:#1a1a1a;--muted:#6b6b6b;--card:#fff;--border:#e4e4df;--accent:#2563eb;--live:#166534;--live-bg:#e7f6ec;--chip:#f0f0ec;--shadow:0 1px 2px rgba(0,0,0,.04),0 6px 18px rgba(0,0,0,.05)}
  @media (prefers-color-scheme:dark){:root{--bg:#101014;--fg:#ececec;--muted:#9a9aa2;--card:#17171c;--border:#26262e;--accent:#7aa2ff;--live:#7ee2a3;--live-bg:#123321;--chip:#22222a;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35)}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .wrap{max-width:820px;margin:0 auto;padding:0 20px}
  header.site{padding:40px 0 8px}header.site h1{margin:0;font-size:1.15rem;letter-spacing:-.01em}header.site h1 a{color:var(--fg)}
  .back{display:inline-flex;align-items:center;gap:6px;font-weight:600;margin:24px 0 18px}
  .top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
  h2{margin:0;font-size:clamp(1.7rem,4vw,2.4rem);letter-spacing:-.02em}
  .lead{font-size:1.1rem;color:var(--muted);margin:10px 0 0;max-width:65ch}
  .badge{display:inline-flex;align-items:center;gap:6px;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:var(--chip);border-radius:999px;padding:3px 9px}
  .badge .dot{width:7px;height:7px;border-radius:50%;background:var(--live)}
  .hero{margin:22px 0 0;border:1px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}
  .thumb{display:block;aspect-ratio:16/10;background:var(--card);overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:contain;display:block}
  .thumb.ph{display:grid;place-items:center;color:#0b0b0b;font-weight:800;font-size:2.4rem;background:linear-gradient(135deg,hsl(var(--h) 70% 78%),hsl(calc(var(--h) + 40) 65% 68%))}
  .section{margin-top:30px}.section>h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:0 0 10px}
  .section p{margin:0;max-width:72ch}
  .chips{list-style:none;display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0}.chips li{background:var(--chip);color:var(--fg);font-size:.82rem;padding:5px 11px;border-radius:999px}
  .links{display:flex;flex-wrap:wrap;gap:10px 20px;font-weight:600}
  .meta{display:flex;flex-wrap:wrap;gap:18px;margin-top:8px;color:var(--muted);font-size:.9rem}.meta strong{color:var(--fg);font-weight:600}
  footer.site{margin-top:56px;border-top:1px solid var(--border);padding:28px 0 56px;color:var(--muted);font-size:.9rem}
`;

function detailPage(p) {
  const title = p.display_title;
  const desc = (p.tagline || p.short_description || SITE_DESC).slice(0, 300);
  const pageUrl = absPage(p);
  const image = p.thumb ? `${SITE}/${p.thumb}` : `${SITE}/og.png`;
  const about = p.long_description || p.short_description || p.tagline || "";
  const summary = (p.short_description && p.long_description) ? p.short_description : "";
  const tech = (p.tech || []).length
    ? `<ul class="chips">${p.tech.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  const tags = (p.tags || []).length
    ? `<ul class="chips">${p.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  const sameAs = [p.live_url, p.repo_url].filter(Boolean);

  const ld = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: title,
    description: desc,
    url: pageUrl,
    image,
    ...(p.category ? { genre: p.category } : {}),
    ...(p.tech && p.tech.length ? { keywords: p.tech.join(", ") } : {}),
    isPartOf: { "@type": "WebSite", "@id": `${SITE}/#website`, name: SITE_NAME, url: `${SITE}/` },
    author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
    ...(sameAs.length ? { sameAs } : {}),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/favicon.ico">
<title>${esc(title)} — Livive Projects</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Livive">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="${p.thumb ? "640" : "1200"}">
<meta property="og:image:height" content="${p.thumb ? "400" : "630"}">
<meta property="og:image:alt" content="${esc(thumbAlt(p))}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${image}">
${ldScript(ld)}
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="site"><h1><a href="/">Livive Projects</a></h1></header>
  <article>
    <a class="back" href="/">&larr; All projects</a>
    <div class="top">
      <h2>${esc(title)}</h2>
      <div>${statusChip(p)}</div>
    </div>
    <p class="lead">${esc(p.tagline || "")}</p>
    <div class="hero">${thumbHtml(p)}</div>
    ${about ? `<div class="section"><h3>About</h3><p>${esc(about)}</p></div>` : ""}
    ${summary ? `<div class="section"><h3>Summary</h3><p>${esc(summary)}</p></div>` : ""}
    ${tech ? `<div class="section"><h3>Tech</h3>${tech}</div>` : ""}
    ${tags ? `<div class="section"><h3>Tags</h3>${tags}</div>` : ""}
    <div class="section">
      <h3>Links</h3>
      <div class="links">
        ${demoLinks(p)}
        <a href="${esc(p.repo_url)}"${EXT}>GitHub repository &rarr;${NEWTAB}</a>
        <a href="/#project=${encodeURIComponent(p.key)}">Open interactive view &rarr;</a>
      </div>
    </div>
    <div class="meta">
      <span>Category: <strong>${esc(p.category || "—")}</strong></span>
      <span>Status: <strong>${esc(p.status || "—")}</strong></span>
    </div>
  </article>
  <footer class="site"><a href="https://github.com/jpeckenpaugh" target="_blank" rel="noopener noreferrer">More on GitHub &rarr;${NEWTAB}</a></footer>
</div>
</body>
</html>
`;
}

// ---- helpers ---------------------------------------------------------------
function replaceBetween(html, start, end, body) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`markers not found in index.html: ${start} / ${end}`);
  }
  return html.slice(0, a + start.length) + "\n" + body + "\n" + html.slice(b);
}

function sitemap(data, lastmod) {
  const urls = [
    { loc: `${SITE}/`, priority: "1.0", freq: "weekly" },
    ...data.projects.map((p) => ({
      loc: absPage(p), priority: "0.6", freq: "monthly",
    })),
  ];
  const entries = urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
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

  // index.html: prerendered listing + JSON-LD
  let html = await readFile(INDEX, "utf8");
  const before = html;
  html = replaceBetween(html, MAIN_START, MAIN_END, listing(data));
  html = replaceBetween(html, JSONLD_START, JSONLD_END, indexJsonLd(data));
  if (html !== before) await writeFile(INDEX, html);

  // per-project static landing pages
  for (const p of data.projects) {
    const dir = path.join(PAGES, p.key);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), detailPage(p));
  }

  await writeFile(SITEMAP, sitemap(data, lastmod));
  await writeFile(ROBOTS, ROBOTS_TXT);

  console.log(
    `rendered ${data.projects.length} projects -> index.html, p/<key>/index.html, sitemap.xml, robots.txt`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
