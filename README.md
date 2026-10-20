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

## Per-project showcase bundles

Project repos can publish their own showcase media with a manual
`.github/workflows/showcase.yml` run. It writes:

```
demos/latest/demo.webm      ~30s silent 16:10 recording
demos/latest/thumb.webp     1280x800 card thumbnail
demos/latest/poster.webp    960x600 poster
demos/latest/manifest.json  labels + timings + git revision
demos/latest/gallery/*.png  labeled stills
```

Fold a bundle into the catalogue with:

```bash
node _bootstrap/sync-showcase.mjs --keys trot-livive-net fourcast-livive-net
node _bootstrap/sync-showcase.mjs --raw --keys trot-livive-net   # after push
```

Local mode copies the media into `previews/` and `thumbnails/` for staging;
`--raw` points `previews.json` at `raw.githubusercontent.com` instead. Then copy
`previews.json` to the netfix root (or run `node build_site.mjs` there) and
re-run step 5.
