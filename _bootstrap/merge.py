#!/usr/bin/env python3
"""Merge per-repo agent entries into the canonical projects.json for the site."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent
ENTRIES = ROOT / "entries"
OUT = ROOT.parent / "projects.json"

CATEGORY_ORDER = [
    "Games",
    "AI/ML Experiments",
    "Language Tools",
    "Dev Tools",
    "Education & Teaching",
    "Web Apps & Prototypes",
]

# Repos that are infrastructure/site-root artifacts or empty, not project listings.
EXCLUDE = {
    "jpeckenpaugh.github.io",  # account-root Pages site (currently serves the Lokarta demo)
    "sd-langtutor.github.io",  # empty on this account (real project lives under another org)
    "ll-seekdepth-net",        # repo deleted; was an empty placeholder with a broken TLS cert
}

# Iterations of the same project -> collapse into a single listing (first key wins as primary).
MERGES = [
    ["company-hub", "ch"],  # both "Company Hub"; ch carries the live Pages site
]


def normalize_url(u):
    if not u:
        return None
    if u.startswith("//"):
        u = "https:" + u
    if u.startswith("http://"):
        u = "https://" + u[len("http://"):]
    return u


def clean(d):
    d["live_url"] = normalize_url(d.get("live_url"))
    demos = d.get("demos") or []
    for dm in demos:
        dm["url"] = normalize_url(dm["url"])
    if not demos and d.get("live_url"):
        demos = [{"label": "Play", "url": d["live_url"]}]
    d["demos"] = [dm for dm in demos if dm.get("url")]
    d["has_live_demo"] = bool(d["demos"]) or (
        bool(d.get("live_url")) and bool(d.get("has_live_demo", True))
    )
    if not d["live_url"] and d["demos"]:
        d["live_url"] = d["demos"][0]["url"]
    d["featured"] = bool(d.get("featured"))
    d["tags"] = sorted({t.strip().lower() for t in d.get("tags", []) if t.strip()})
    d["tech"] = [t.strip() for t in d.get("tech", []) if t.strip()]
    if d.get("category") not in CATEGORY_ORDER:
        d["category"] = "Web Apps & Prototypes"
    d["thumb"] = find_thumb(d.get("key"))
    return d


def find_thumb(key):
    for ext in ("webp", "png", "jpg"):
        rel = f"thumbnails/{key}.{ext}"
        if (ROOT.parent / rel).is_file():
            return rel
    return None


def sort_key(d):
    # grouped by category order, then live/featured first, then title
    return (
        not d["has_live_demo"],
        not d["featured"],
        d["display_title"].lower(),
    )


def collapse(by_key):
    """Merge iteration repos into one canonical listing; drop excluded repos."""
    for group in MERGES:
        primary = group[0]
        base = by_key[primary]
        for k in group[1:]:
            o = by_key.get(k)
            if not o:
                continue
            base["tags"] = list({*base.get("tags", []), *o.get("tags", [])})
            base["tech"] = list({*base.get("tech", []), *o.get("tech", [])})
            if not base.get("live_url"):
                base["live_url"] = o.get("live_url")
            base["has_live_demo"] = base["has_live_demo"] or o.get("has_live_demo", False)
            base["featured"] = base["featured"] or o.get("featured", False)
            if o.get("notes"):
                base["notes"] = f"{base.get('notes','')} | {k}: {o['notes']}".strip(" |")
            by_key.pop(k, None)
        base["repos"] = list(group)
        base["repo"] = group[0] if len(group) == 1 else list(group)


def main():
    raw = {}
    for f in sorted(ENTRIES.glob("*.json")):
        d = json.loads(f.read_text())
        raw[d["key"]] = d
    collapse(raw)
    projects = [clean(d) for k, d in raw.items() if k not in EXCLUDE]

    projects.sort(key=lambda d: (CATEGORY_ORDER.index(d["category"]),) + sort_key(d))

    groups = []
    for cat in CATEGORY_ORDER:
        items = [p for p in projects if p["category"] == cat]
        if items:
            groups.append({"category": cat, "projects": items})

    out = {
        "source_user": "jpeckenpaugh",
        "count": len(projects),
        "live_count": sum(1 for p in projects if p["has_live_demo"]),
        "featured_count": sum(1 for p in projects if p["featured"]),
        "category_order": CATEGORY_ORDER,
        "projects": projects,
        "groups": groups,
    }
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT} ({out['count']} projects, {out['live_count']} live)")
    for g in groups:
        print(f"  {g['category']}: {len(g['projects'])}"
              f" (live {sum(1 for p in g['projects'] if p['has_live_demo'])})")


if __name__ == "__main__":
    main()
