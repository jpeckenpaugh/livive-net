# livive-net
Just some projects...

## Build pipeline (`_bootstrap/`)

The landing page is generated from `projects.json` by a small, manual pipeline:

1. `python3 _bootstrap/collect.py` — harvest repo metadata into `_bootstrap/entries/`
2. `python3 _bootstrap/merge.py` — merge entries into `projects.json`
3. `node _bootstrap/thumbs.mjs` — capture thumbnails into `thumbnails/`
4. `node _bootstrap/previews.mjs` — capture short muted **preview clips** into
   `previews/` and write the `previews.json` manifest. A real Playwright
   recording is used when a Chromium can launch; otherwise the thumbnail is
   animated into a light "loading" clip (sharp + the bundled Playwright ffmpeg)
   so every live demo still has a video preview.
5. `node _bootstrap/render.mjs` — **SEO render**: rewrites `index.html`
   (Netflix-style billboard + rails + JSON-LD), `robots.txt`, and `sitemap.xml`
   so the static HTML stays in sync with `projects.json` + `previews.json`.

Run step 5 after any change to `projects.json` so crawlers and no-JS clients see
the full project catalog.
