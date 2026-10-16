#!/usr/bin/env node
/*
 * Static SEO renderer for livive.net.
 *
 * Reads projects.json (+ optional previews.json) and writes, in place:
 *   - index.html            -> prerendered Netflix-style catalogue + JSON-LD
 *   - p/<key>/index.html    -> static per-project "title" pages (OG + JSON-LD)
 *   - sitemap.xml           -> crawlable URL list (home + project pages)
 *   - robots.txt            -> crawl policy + sitemap pointer
 *
 * The prerendered catalogue mirrors the client-side rails (billboard + genre
 * rows + signal rows) so non-JS crawlers and social scrapers get real project
 * content, per-project Open Graph metadata, and preview videos when present.
 * The client-side hash detail view in index.html remains the interactive
 * experience for JS users.
 *
 * Run after merge.py / thumbs.mjs / previews.mjs:  node _bootstrap/render.mjs
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
const PREVIEWS = path.join(ROOT, "previews.json");

const MAIN_START = "<!-- projects:start -->";
const MAIN_END = "<!-- projects:end -->";
const JSONLD_START = "<!-- seo:jsonld:start -->";
const JSONLD_END = "<!-- seo:jsonld:end -->";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const safeDate = (s) => { const t = Date.parse(s || ""); return Number.isFinite(t) ? t : 0; };
const isNew = (p) => safeDate(p.updated_at) > 0 && (Date.now() - safeDate(p.updated_at)) < WEEK_MS;
const relDate = (s) => {
  const t = safeDate(s); if (!t) return "";
  const days = Math.round((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  if (days < 30) return Math.round(days / 7) + "w ago";
  if (days < 365) return Math.round(days / 30) + "mo ago";
  return Math.round(days / 365) + "y ago";
};

const EXT = ` target="_blank" rel="noopener noreferrer"`;
const NEWTAB = `<span class="sr-only"> (opens in a new tab)</span>`;
const pageHref = (p) => `p/${encodeURIComponent(p.key)}/`;
const absPage = (p) => `${SITE}/${pageHref(p)}`;

const thumbAlt = (p) => {
  const bits = [p.display_title];
  if (p.tagline) bits.push(p.tagline);
  else if (p.category) bits.push(p.category + " project");
  return bits.join(" — ").slice(0, 240);
};

const thumbDims = (p) => (p.thumb_width && p.thumb_height)
  ? ` width="${Number(p.thumb_width)}" height="${Number(p.thumb_height)}"` : "";

const demosOf = (p) => (p.demos && p.demos.length) ? p.demos
  : (p.has_live_demo ? [{ label: "Play", url: p.live_url }] : []);

const previewFor = (p, previews) => (previews && previews[p.key]) || null;

function posterMedia(p, previews) {
  if (!p.thumb) return { html: esc(initials(p.display_title)), ph: true, attrs: "", hasPreview: false };
  const pv = previewFor(p, previews);
  const img = `<img loading="lazy" src="/${esc(p.thumb)}" alt="${esc(thumbAlt(p))}"${thumbDims(p)}>`;
  // Preview <video> is created on demand client-side; the static page stays image-only.
  const attrs = pv && pv.video
    ? ` data-preview="/${esc(pv.video)}" data-poster="/${esc(pv.poster || p.thumb)}"`
    : "";
  return { html: img, ph: false, attrs, hasPreview: !!(pv && pv.video) };
}

function card(p, previews) {
  const title = esc(p.display_title);
  const href = pageHref(p);
  const media = posterMedia(p, previews);
  const ribbons = [];
  if (isNew(p)) ribbons.push(`<span class="badge new">New</span>`);
  if (p.has_live_demo) ribbons.push(`<span class="badge live"><span class="dot" aria-hidden="true"></span>Playable</span>`);
  const poster = media.ph
    ? `<div class="poster ph" style="--h:${hue(p.key)}" aria-hidden="true">${media.html}</div>`
    : `<div class="poster${media.hasPreview ? " has-preview" : ""}"${media.attrs}>${media.html}
        <span class="scrim" aria-hidden="true"></span>
        <span class="ribbons">${ribbons.join("")}</span>
        <span class="play" aria-hidden="true"><span>&#9658;</span></span></div>`;
  return `<article class="card">
      <a class="card-link" href="${href}" aria-label="${title} — open details">
        ${poster}
        <span class="caption"><h3>${title}</h3><span class="tagline">${esc(p.tagline || p.category || "")}</span></span>
      </a>
    </article>`;
}

function buildRails(data) {
  const projects = data.projects.slice();
  const byUpdated = projects.slice().sort((a, b) => safeDate(b.updated_at) - safeDate(a.updated_at));
  const rails = [];
  const fresh = byUpdated.filter(isNew);
  if (fresh.length) rails.push({ id: "new", title: "New this week", sub: "freshly shipped", items: fresh });
  const playable = projects.filter((p) => p.has_live_demo || (p.demos && p.demos.length));
  if (playable.length) rails.push({ id: "playable", title: "Playable right now", sub: "no install, just a browser", items: playable });
  rails.push({ id: "updated", title: "Recently updated", sub: "latest work first", items: byUpdated.slice(0, 14) });
  const featured = projects.filter((p) => p.featured);
  if (featured.length) rails.push({ id: "featured", title: "Featured picks", sub: "the ones worth a look", items: featured });
  const order = data.category_order || [];
  const cats = [...new Set([...order, ...projects.map((p) => p.category).filter(Boolean)])];
  for (const c of cats) {
    const items = projects.filter((p) => p.category === c);
    if (items.length) rails.push({ id: "cat-" + c, title: c, sub: "", items });
  }
  const techCount = {};
  for (const p of projects) for (const t of (p.tech || [])) techCount[t] = (techCount[t] || 0) + 1;
  const topTech = Object.entries(techCount).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [t] of topTech) {
    rails.push({ id: "tech-" + t, title: "Built with " + t, sub: "", items: projects.filter((p) => (p.tech || []).includes(t)) });
  }
  return rails;
}

function pickHero(data, previews) {
  const projects = data.projects;
  const withPreview = projects.filter((p) => previewFor(p, previews) && p.has_live_demo);
  const pool = withPreview.length ? withPreview : projects.filter((p) => p.featured && p.has_live_demo);
  const pool2 = pool.length ? pool : projects.filter((p) => p.has_live_demo);
  const pool3 = pool2.length ? pool2 : projects;
  const fresh = pool3.filter(isNew);
  return (fresh.length ? fresh : pool3).sort((a, b) => safeDate(b.updated_at) - safeDate(a.updated_at))[0];
}

function billboardHtml(p) {
  const demo = demosOf(p)[0];
  const backdrop = p.thumb
    ? `<div class="billboard-backdrop" style="background-image:url('/${esc(p.thumb)}')" aria-hidden="true"></div>` : "";
  const play = demo
    ? `<a class="btn btn-primary" href="${esc(demo.url)}"${EXT}>&#9658; ${esc(demo.label || "Play")}${NEWTAB}</a>` : "";
  return `<section class="billboard" aria-labelledby="hero-title">
    ${backdrop}
    <div class="billboard-fade" aria-hidden="true"></div>
    <div class="billboard-inner">
      <p class="flag"><span class="mark" aria-hidden="true">L</span> Livive original${isNew(p) ? " · New this week" : ""}</p>
      <h1 id="hero-title">${esc(p.display_title)}</h1>
      <div class="meta">
        ${p.category ? `<span class="badge">${esc(p.category)}</span>` : ""}
        ${p.has_live_demo ? `<span class="badge live"><span class="dot" aria-hidden="true"></span>Playable</span>` : ""}
        ${p.updated_at ? `<span class="badge">Updated ${esc(relDate(p.updated_at))}</span>` : ""}
        ${p.status ? `<span class="badge status">${esc(p.status)}</span>` : ""}
      </div>
      <p class="tagline">${esc(p.tagline || p.short_description || "")}</p>
      <div class="actions">
        ${play}
        <a class="btn btn-ghost" href="${pageHref(p)}">&#9432; More info</a>
        ${p.repo_url ? `<a class="btn btn-ghost" href="${esc(p.repo_url)}"${EXT}>Source${NEWTAB}</a>` : ""}
      </div>
    </div>
  </section>`;
}

function listing(data, previews) {
  const hero = pickHero(data, previews);
  const rails = buildRails(data).map((rail) => `  <section class="rail" id="rail-${slug(rail.id)}" aria-labelledby="railh-${slug(rail.id)}">
    <div class="rail-head">
      <h2 id="railh-${slug(rail.id)}">${esc(rail.title)}</h2>
      ${rail.sub ? `<span class="rail-sub">${esc(rail.sub)}</span>` : ""}
    </div>
    <div class="track" tabindex="0" role="group" aria-label="${esc(rail.title)}, scroll horizontally">${rail.items.map((p) => card(p, previews)).join("")}</div>
  </section>`).join("\n");
  return billboardHtml(hero) + "\n" + rails;
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

// ---- per-project "title" page ----------------------------------------------
const PAGE_CSS = `
  :root{color-scheme:dark;--bg:#0b0b0e;--bg2:#101014;--surface:#17171c;--surface2:#202027;--fg:#f6f6f7;--muted:#b6b6bf;--border:#2b2b34;--accent:#e50914;--accent-fg:#fff;--link:#ff9ea2;--live:#6ee7a4;--live-bg:rgba(110,231,164,.14);--new:#ffd166;--new-bg:rgba(255,209,102,.15);--shadow:0 6px 24px rgba(0,0,0,.55);--shadow-lg:0 24px 80px rgba(0,0,0,.7)}
  *{box-sizing:border-box}body{margin:0;background:var(--bg2);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
  img,video{max-width:100%}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .skip-link{position:absolute;left:-9999px;top:8px;z-index:200;background:var(--fg);color:var(--bg);font-weight:700;padding:10px 14px;border-radius:10px}
  .skip-link:focus{left:12px}
  :focus-visible{outline:2px solid var(--link);outline-offset:3px;border-radius:4px}
  header.topbar{position:sticky;top:0;z-index:60;background:linear-gradient(180deg,rgba(11,11,14,.96),rgba(11,11,14,.7) 70%,rgba(11,11,14,0))}
  .topbar-inner{max-width:1100px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:14px}
  .brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg);font-weight:900;letter-spacing:-.02em}
  .brand:hover{text-decoration:none}
  .brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--accent);color:#fff;font-weight:900;font-size:18px}
  .brand-word{font-size:1.24rem;letter-spacing:.14em}
  .detail-backdrop{position:absolute;inset:0;height:58vh;background-size:cover;background-position:center 30%;opacity:.45;-webkit-mask-image:linear-gradient(180deg,#000 55%,transparent);mask-image:linear-gradient(180deg,#000 55%,transparent)}
  .wrap{position:relative;z-index:2;max-width:1100px;margin:0 auto;padding:0 20px}
  .back{display:inline-flex;align-items:center;gap:8px;font-weight:700;margin:18px 0 22px;color:var(--fg);background:rgba(0,0,0,.4);padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16)}
  .back:hover{text-decoration:none}
  .hero{position:relative;border-radius:16px;overflow:hidden;box-shadow:var(--shadow-lg);border:1px solid var(--border);background:#000}
  .media{position:relative;aspect-ratio:16/9}
  .media img,.media video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
  .media video{z-index:1}
  .media.ph{display:grid;place-items:center;font-size:3rem;font-weight:900;color:#fff;background:linear-gradient(135deg,hsl(var(--h) 66% 40%),hsl(calc(var(--h) + 42) 62% 22%))}
  h1.title{margin:26px 0 10px;font-size:clamp(1.8rem,4.4vw,3rem);letter-spacing:-.03em;outline:none}
  .meta{display:flex;flex-wrap:wrap;align-items:center;gap:12px;color:var(--muted);font-size:.92rem;margin-bottom:14px}
  .lead{font-size:clamp(1rem,1.6vw,1.2rem);color:#e2e2e8;max-width:68ch;margin:0 0 20px}
  .actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
  .btn{display:inline-flex;align-items:center;gap:9px;font:inherit;font-weight:700;padding:11px 22px;border-radius:8px;border:1px solid transparent;cursor:pointer}
  .btn:hover{text-decoration:none}
  .btn-primary{background:var(--accent);color:var(--accent-fg)}
  .btn-ghost{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.22)}
  .badge{display:inline-flex;align-items:center;gap:6px;font-size:.64rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;border-radius:999px;padding:3px 8px;background:var(--surface2);color:var(--fg);border:1px solid rgba(255,255,255,.14)}
  .badge .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .badge.status{color:var(--muted)}.badge.status .dot{background:var(--live)}
  .badge.live{background:var(--live-bg);color:var(--live);border-color:transparent}
  .badge.new{background:var(--new-bg);color:var(--new);border-color:transparent}
  .section{margin-top:34px}.section>h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:0 0 12px}
  .section p{margin:0 0 10px;max-width:74ch;color:#dcdce2}
  .chips{list-style:none;display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0}.chips li{background:var(--surface2);color:var(--fg);font-size:.82rem;padding:5px 12px;border-radius:999px;border:1px solid var(--border)}
  .episodes{list-style:none;margin:0;padding:0;border-top:1px solid var(--border)}
  .episode{display:flex;align-items:center;gap:16px;padding:14px 6px;border-bottom:1px solid var(--border)}
  .episode .no{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:700;width:3.4rem}
  .episode .ep-body{flex:1 1 auto;min-width:0}  .episode .ep-body strong{display:block}.episode .ep-body span{color:var(--muted);font-size:.85rem;word-break:break-all}
  .shots{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:18px;padding:0;margin:0}
  .shot{margin:0;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
  .shot img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;background:#000}
  .shot figcaption{padding:10px 12px;font-size:.85rem;color:var(--muted);font-weight:700}
  footer.site{border-top:1px solid var(--border);margin-top:40px;padding:30px 20px 60px;color:var(--muted);font-size:.88rem;text-align:center}footer.site a{color:var(--muted)}
`;

function detailPage(p, previews) {
  const title = p.display_title;
  const desc = (p.tagline || p.short_description || SITE_DESC).slice(0, 300);
  const pageUrl = absPage(p);
  const image = p.thumb ? `${SITE}/${p.thumb}` : `${SITE}/og.png`;
  const about = p.long_description || p.short_description || p.tagline || "";
  const summary = (p.short_description && p.long_description) ? p.short_description : "";
  const pv = previewFor(p, previews);
  const gallery = (pv && Array.isArray(pv.gallery)) ? pv.gallery : [];
  const tech = (p.tech || []).length
    ? `<ul class="chips">${p.tech.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  const tags = (p.tags || []).length
    ? `<ul class="chips">${p.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  const sameAs = [p.live_url, p.repo_url].filter(Boolean);
  const demos = demosOf(p);
  const backdrop = p.thumb
    ? `<div class="detail-backdrop" style="background-image:url('/${esc(p.thumb)}')" aria-hidden="true"></div>` : "";

  const media = p.thumb
    ? `<div class="media"><img src="/${esc(p.thumb)}" alt="${esc(thumbAlt(p))}"${thumbDims(p)}>${
        pv && pv.video ? `<video muted loop playsinline autoplay preload="metadata" aria-hidden="true" tabindex="-1" data-src="/${esc(pv.video)}" poster="/${esc(pv.poster || p.thumb)}"></video>` : ""
      }</div>`
    : `<div class="media ph" style="--h:${hue(p.key)}" aria-hidden="true">${esc(initials(p.display_title))}</div>`;

  const play = demos[0]
    ? `<a class="btn btn-primary" href="${esc(demos[0].url)}"${EXT}>&#9658; ${esc(demos[0].label || "Play")}${NEWTAB}</a>` : "";
  const episodes = demos.map((dm, i) => `<li class="episode">
      <span class="no">S01E${String(i + 1).padStart(2, "0")}</span>
      <span class="ep-body"><strong>${esc(dm.label || "Demo " + (i + 1))}</strong><span>${esc(dm.url)}</span></span>
      <span class="ep-go"><a class="btn btn-ghost" href="${esc(dm.url)}"${EXT}>&#9658; Watch${NEWTAB}</a></span>
    </li>`).join("");

  const shots = gallery.map((g) => `<figure class="shot">
      <img loading="lazy" src="/${esc(g.src)}" alt="${esc(g.alt || g.label || title)}" width="960" height="720">
      ${g.label ? `<figcaption>${esc(g.label)}</figcaption>` : ""}
    </figure>`).join("");
  const screenshots = shots
    ? `<div class="section"><h3>Screenshots</h3><div class="shots">${shots}</div></div>` : "";

  const ld = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: title,
    description: desc,
    url: pageUrl,
    image: [image, ...gallery.map((g) => `${SITE}/${g.src}`)],
    ...(p.category ? { genre: p.category } : {}),
    ...(p.tech && p.tech.length ? { keywords: p.tech.join(", ") } : {}),
    isPartOf: { "@type": "WebSite", "@id": `${SITE}/#website`, name: SITE_NAME, url: `${SITE}/` },
    author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
    ...(sameAs.length ? { sameAs } : {}),
    ...(pv && pv.video ? { video: { "@type": "VideoObject", contentUrl: `${SITE}/${pv.video}`, thumbnailUrl: `${SITE}/${pv.poster || p.thumb}`, ...(pv.duration_ms ? { duration: `PT${Math.round(pv.duration_ms / 1000)}S` } : {}) } } : {}),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/favicon.ico">
<title>${esc(title)} — Livive</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${pageUrl}">
<meta name="theme-color" content="#0b0b0e">
<meta name="color-scheme" content="dark">
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
<a class="skip-link" href="#main">Skip to details</a>
${backdrop}
<div class="wrap">
  <header class="topbar"><div class="topbar-inner">
    <a class="brand" href="/" aria-label="Livive home"><span class="brand-mark" aria-hidden="true">L</span><span class="brand-word">LIVIVE</span></a>
  </div></header>
  <main id="main">
    <a class="back" href="/">&larr; Browse all</a>
    <div class="hero">${media}</div>
    <h1 class="title">${esc(title)}</h1>
    <div class="meta">
      ${isNew(p) ? `<span class="badge new">New this week</span>` : ""}
      ${p.category ? `<span>${esc(p.category)}</span>` : ""}
      ${p.has_live_demo ? `<span class="badge live"><span class="dot" aria-hidden="true"></span>Playable</span>` : ""}
      ${p.updated_at ? `<span>Updated ${esc(relDate(p.updated_at))}</span>` : ""}
    </div>
    <p class="lead">${esc(p.tagline || "")}</p>
    <div class="actions">
      ${play}
      <a class="btn btn-ghost" href="${esc(p.repo_url)}"${EXT}>GitHub repository &rarr;${NEWTAB}</a>
      <a class="btn btn-ghost" href="/#project=${encodeURIComponent(p.key)}">Open interactive view &rarr;</a>
    </div>
    ${episodes ? `<div class="section"><h3>Episodes &amp; demos</h3><ul class="episodes">${episodes}</ul></div>` : ""}
    ${screenshots}
    ${about ? `<div class="section"><h3>About</h3><p>${esc(about)}</p></div>` : ""}
    ${summary ? `<div class="section"><h3>Summary</h3><p>${esc(summary)}</p></div>` : ""}
    ${tech ? `<div class="section"><h3>Tech</h3>${tech}</div>` : ""}
    ${tags ? `<div class="section"><h3>Tags</h3>${tags}</div>` : ""}
  </main>
  <footer class="site"><a href="https://github.com/jpeckenpaugh" target="_blank" rel="noopener noreferrer">More on GitHub &rarr;${NEWTAB}</a></footer>
</div>
<script>
(function(){
  var v=document.querySelector(".media video[data-src]");
  if(v){v.src=v.dataset.src;
    var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(!reduce){var p=v.play();if(p&&p.catch)p.catch(function(){});}
  }
})();
</script>
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

async function loadPreviews() {
  try {
    const raw = await readFile(PREVIEWS, "utf8");
    const doc = JSON.parse(raw);
    return doc.previews || {};
  } catch {
    return {};
  }
}

async function main() {
  const data = JSON.parse(await readFile(path.join(ROOT, "projects.json"), "utf8"));
  const previews = await loadPreviews();
  const lastmod = (process.env.LIVIVE_LASTMOD || new Date().toISOString()).slice(0, 10);

  // index.html: prerendered catalogue + JSON-LD
  let html = await readFile(INDEX, "utf8");
  const before = html;
  html = replaceBetween(html, MAIN_START, MAIN_END, listing(data, previews));
  html = replaceBetween(html, JSONLD_START, JSONLD_END, indexJsonLd(data));
  if (html !== before) await writeFile(INDEX, html);

  // per-project static title pages
  for (const p of data.projects) {
    const dir = path.join(PAGES, p.key);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), detailPage(p, previews));
  }

  await writeFile(SITEMAP, sitemap(data, lastmod));
  await writeFile(ROBOTS, ROBOTS_TXT);

  console.log(
    `rendered ${data.projects.length} projects -> index.html, p/<key>/index.html, sitemap.xml, robots.txt ` +
      `(${Object.keys(previews).length} previews)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
