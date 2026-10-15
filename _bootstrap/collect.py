#!/usr/bin/env python3
"""Deterministic bootstrap collector for the livive.net landing page.

For every public repo under the configured GitHub user it gathers evidence into a
per-repo *dossier* (JSON + Markdown) that a downstream sub-agent consumes. Agents
synthesize; this script only gathers facts.

Sources:
  1. GitHub repo list API (one call, cached) -> metadata + has_pages.
  2. Blobless partial clone (--filter=blob:none) -> file tree, README, manifests.
  3. HTTP probe of the live site (for has_pages repos) -> <title>/meta/og tags.

Run:  python3 _bootstrap/collect.py
"""

from __future__ import annotations

import base64
import concurrent.futures as futures
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

USER = "jpeckenpaugh"
ROOT = Path(__file__).resolve().parent
CLONE_DIR = ROOT / "clones"
DOSSIER_DIR = ROOT / "dossiers"
REPOS_JSON = ROOT / "repos.json"

GIT_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}

# Files whose contents are worth fetching for tech/stack signal.
MANIFEST_CANDIDATES = [
    "package.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "environment.yml",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Makefile",
    "index.html",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "tsconfig.json",
    "tailwind.config.js",
    "tailwind.config.ts",
    "manifest.json",
    "CNAME",
]

READ_EXT_LANG = {
    ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".jsx": "JavaScript", ".java": "Java",
    ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP", ".cs": "C#",
    ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C", ".hpp": "C++", ".swift": "Swift",
    ".kt": "Kotlin", ".scala": "Scala", ".sh": "Shell", ".bash": "Shell",
    ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS", ".sass": "Sass",
    ".less": "Less", ".sql": "SQL", ".r": "R", ".m": "Objective-C/MATLAB",
    ".jl": "Julia", ".lua": "Lua", ".dart": "Dart", ".vue": "Vue", ".svelte": "Svelte",
    ".json": "JSON", ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".md": "Markdown",
    ".dockerfile": "Docker", ".ipynb": "Jupyter",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd, cwd=None, timeout=180):
    return subprocess.run(
        cmd, cwd=cwd, env=GIT_ENV, capture_output=True, text=True, timeout=timeout
    )


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "livive-bootstrap"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def load_repos():
    if REPOS_JSON.exists():
        return json.loads(REPOS_JSON.read_text())
    data = []
    page = 1
    while True:
        chunk = fetch_json(
            f"https://api.github.com/users/{USER}/repos?per_page=100&page={page}&sort=full_name"
        )
        if not chunk:
            break
        data.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    REPOS_JSON.write_text(json.dumps(data, indent=2))
    return data


def clone(repo: str) -> str | None:
    dest = CLONE_DIR / repo
    if dest.exists():
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{USER}/{repo}.git"
    r = run([
        "git", "clone", "--depth", "1", "--filter=blob:none",
        "--no-checkout", "-q", url, str(dest),
    ])
    if r.returncode != 0:
        return f"clone failed: {r.stderr.strip()[:300]}"
    return "ok"


def ls_files(dest: Path):
    r = run(["git", "-C", str(dest), "ls-tree", "-r", "--name-only", "HEAD"])
    if r.returncode != 0:
        return None, r.stderr.strip()
    return [l for l in r.stdout.splitlines() if l.strip()], None


def git_show(dest: Path, path: str, max_bytes=20000):
    r = run(["git", "-C", str(dest), "show", f"HEAD:{path}"])
    if r.returncode != 0:
        return None
    return r.stdout[:max_bytes]


def find_readme(files):
    cands = [f for f in files if re.search(r"(^|/)readme(\.|$)", f, re.I)]
    cands.sort(key=lambda p: (p.count("/"), len(p)))
    return cands[0] if cands else None


def ext_histogram(files):
    counts = {}
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext in READ_EXT_LANG:
            lang = READ_EXT_LANG[ext]
            counts[lang] = counts.get(lang, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def meta_tag(html: str, name: str):
    m = re.search(
        rf'<meta[^>]+(?:name|property)=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']*)["\']',
        html, re.I,
    )
    if not m:
        m = re.search(
            rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:name|property)=["\']{re.escape(name)}["\']',
            html, re.I,
        )
    return m.group(1).strip() if m else None


def probe(url: str, timeout=20):
    out = {"url": url, "status": None, "title": None, "meta_description": None,
           "og_title": None, "og_description": None, "error": None}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 livive-bootstrap"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out["status"] = r.status
            out["final_url"] = r.geturl()
            html = r.read(200_000).decode("utf-8", "replace")
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        if m:
            out["title"] = re.sub(r"\s+", " ", m.group(1)).strip()
        out["meta_description"] = meta_tag(html, "description")
        out["og_title"] = meta_tag(html, "og:title")
        out["og_description"] = meta_tag(html, "og:description")
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["error"] = f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def live_urls(repo_meta):
    """Return candidate live URLs, best first."""
    urls = []
    home = repo_meta.get("homepage")
    name = repo_meta["name"]
    if name.lower() == f"{USER}.github.io":
        urls.append(f"https://{USER}.github.io/")
    elif repo_meta.get("has_pages"):
        urls.append(f"https://{USER}.github.io/{name}/")
    if home:
        urls.append(home)
    seen, out = set(), []
    for u in urls:
        u = u.rstrip("/") + "/"
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def build_dossier(repo_meta):
    name = repo_meta["name"]
    d = {
        "repo": name,
        "meta": {
            "description": repo_meta.get("description"),
            "homepage": repo_meta.get("homepage"),
            "language": repo_meta.get("language"),
            "topics": repo_meta.get("topics") or [],
            "has_pages": repo_meta.get("has_pages"),
            "size_kb": repo_meta.get("size"),
            "created_at": repo_meta.get("created_at"),
            "pushed_at": repo_meta.get("pushed_at"),
            "license": (repo_meta.get("license") or {}).get("spdx_id"),
            "stars": repo_meta.get("stargazers_count"),
            "forks": repo_meta.get("forks_count"),
            "archived": repo_meta.get("archived"),
            "default_branch": repo_meta.get("default_branch"),
        },
        "repo_url": repo_meta.get("html_url"),
        "clone": {},
        "readme": None,
        "manifests": {},
        "files": {"top_level": [], "count": 0, "notable": []},
        "languages_by_extension": {},
        "live": [],
        "errors": [],
    }

    dest = CLONE_DIR / name
    err = clone(name)
    if err and err != "ok":
        d["errors"].append(err)
    if dest.exists():
        d["clone"]["path"] = str(dest)
        files, lerr = ls_files(dest)
        if lerr:
            d["errors"].append(f"ls-tree: {lerr}")
            files = []
        d["files"]["count"] = len(files)
        d["files"]["top_level"] = sorted({f.split("/")[0] for f in files})
        d["languages_by_extension"] = ext_histogram(files)
        readme_path = find_readme(files)
        if readme_path:
            d["readme"] = {"path": readme_path, "content": git_show(dest, readme_path)}
        # manifests (root or shallowest match)
        for cand in MANIFEST_CANDIDATES:
            matches = [f for f in files if os.path.basename(f) == cand]
            matches.sort(key=lambda p: (p.count("/"), len(p)))
            if matches:
                content = git_show(dest, matches[0], max_bytes=8000)
                if content is not None:
                    d["manifests"][cand] = {"path": matches[0], "content": content}
        # workflow list (names only)
        d["files"]["notable"] = [
            f for f in files
            if re.match(r"\.github/workflows/.*\.ya?ml$", f)
            or os.path.basename(f) in ("CNAME", ".nojekyll", "LICENSE", "LICENSE.md")
        ]

    for url in live_urls(repo_meta):
        p = probe(url)
        d["live"].append(p)
        if p["status"] == 200:
            break

    return d


def write_markdown(d):
    m = d["meta"]
    L = []
    L.append(f"# {d['repo']}")
    L.append("")
    L.append(f"- repo: {d['repo_url']}")
    L.append(f"- language: {m['language']}  |  size: {m['size_kb']} KB  |  stars: {m['stars']}")
    L.append(f"- has_pages: {m['has_pages']}  |  homepage: {m['homepage']}")
    L.append(f"- created: {m['created_at']}  |  pushed: {m['pushed_at']}")
    L.append(f"- description: {m['description']}")
    if m["topics"]:
        L.append(f"- topics: {', '.join(m['topics'])}")
    if d["live"]:
        L.append("- live probes:")
        for p in d["live"]:
            L.append(f"    - {p['url']} -> {p['status']} {p.get('error') or ''}"
                     f" title={p.get('title')!r} desc={p.get('meta_description')!r}")
    if d["languages_by_extension"]:
        langs = ", ".join(f"{k}:{v}" for k, v in list(d["languages_by_extension"].items())[:12])
        L.append(f"- files by extension: {langs}")
    L.append(f"- file count: {d['files']['count']}")
    if d["files"]["top_level"]:
        L.append(f"- top level: {', '.join(d['files']['top_level'])}")
    if d["errors"]:
        L.append(f"- errors: {d['errors']}")
    L.append("")
    L.append("## manifests")
    for k, v in d["manifests"].items():
        L.append(f"### {k} ({v['path']})")
        L.append("```")
        L.append(v["content"][:3000])
        L.append("```")
    L.append("")
    L.append("## README")
    if d["readme"]:
        L.append(f"(from {d['readme']['path']})")
        L.append("")
        L.append((d["readme"]["content"] or "")[:15000])
    else:
        L.append("_none found_")
    return "\n".join(L)


def main():
    for d in (CLONE_DIR, DOSSIER_DIR):
        d.mkdir(parents=True, exist_ok=True)
    repos = load_repos()
    repos = [r for r in repos if not r.get("fork")]  # skip dwarf fork
    log(f"collecting {len(repos)} repos")

    with futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(build_dossier, r): r["name"] for r in repos}
        done = 0
        for fut in futures.as_completed(futs):
            name = futs[fut]
            try:
                d = fut.result()
            except Exception as e:  # noqa: BLE001
                log(f"[FAIL] {name}: {type(e).__name__}: {e}")
                continue
            (DOSSIER_DIR / f"{name}.json").write_text(json.dumps(d, indent=2))
            (DOSSIER_DIR / f"{name}.md").write_text(write_markdown(d))
            live = next((p for p in d["live"] if p["status"] == 200), None)
            done += 1
            log(f"[{done}/{len(repos)}] {name}"
                f" lang={d['meta']['language']} pages={d['meta']['has_pages']}"
                f" files={d['files']['count']}"
                f" live={live['url'] if live else '-'}"
                f"{' ERR:' + str(d['errors']) if d['errors'] else ''}")
    log("done")


if __name__ == "__main__":
    main()
