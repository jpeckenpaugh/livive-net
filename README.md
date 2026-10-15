# livive-net
Just some projects...

## Build pipeline (`_bootstrap/`)

The landing page is generated from `projects.json` by a small, manual pipeline:

1. `python3 _bootstrap/collect.py` — harvest repo metadata into `_bootstrap/entries/`
2. `python3 _bootstrap/merge.py` — merge entries into `projects.json`
3. `node _bootstrap/thumbs.mjs` — capture thumbnails into `thumbnails/`
4. `node _bootstrap/render.mjs` — **SEO render**: rewrites `index.html`
   (prerendered project listing + JSON-LD), `robots.txt`, and `sitemap.xml` so
   the static HTML stays in sync with `projects.json`.

Run step 4 after any change to `projects.json` so crawlers and no-JS clients see
the full project catalog.
