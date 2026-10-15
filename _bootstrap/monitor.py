#!/usr/bin/env python3
"""Live health + recency monitor for the livive.net landing page.

Runs on a schedule (see .github/workflows/monitor.yml) so a broken demo is
detected without a manual rebuild. Two jobs:

  1. Uptime: probe every published live URL (and any secondary demo URLs) and
     record the HTTP status, latency and final URL. Any non-200 is a failure.
  2. Recency: read each repo's last-push timestamp from the GitHub API and store
     it on the project so the site can show how recently a project changed.

Results are folded back into projects.json (and mirrored to status.json for the
status page). To avoid commit churn, files are only rewritten when a status or
recency value actually changes, unless --force is passed.

Exit code is non-zero when any probed URL is not HTTP 200, so the scheduler can
raise an alert.

Usage:
  python3 _bootstrap/monitor.py                # probe + recency, write on change
  python3 _bootstrap/monitor.py --force        # always rewrite outputs
  python3 _bootstrap/monitor.py --only lokarta sm3
  python3 _bootstrap/monitor.py --no-recents   # skip GitHub API calls
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECTS = ROOT.parent / "projects.json"
STATUS = ROOT.parent / "status.json"
USER = "jpeckenpaugh"

PROBE_TIMEOUT = 25
PROBE_RETRIES = 2
MAX_WORKERS = 8
UA = "Mozilla/5.0 (compatible; livive-monitor/1.0; +https://www.livive.net/)"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(msg: str) -> None:
    print(msg, flush=True)


def auth_headers() -> dict:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def probe(url: str, timeout: int = PROBE_TIMEOUT) -> dict:
    """GET a URL following redirects; classify success strictly as HTTP 200."""
    out = {
        "url": url,
        "status": None,
        "ok": False,
        "final_url": None,
        "latency_ms": None,
        "error": None,
    }
    last_err = None
    for attempt in range(PROBE_RETRIES + 1):
        started = dt.datetime.now(dt.timezone.utc)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                r.read(1024)
                out["status"] = r.status
                out["final_url"] = r.geturl()
            out["latency_ms"] = int((dt.datetime.now(dt.timezone.utc) - started).total_seconds() * 1000)
            out["ok"] = out["status"] == 200
            out["error"] = None if out["ok"] else f"HTTP {out['status']}"
            return out
        except urllib.error.HTTPError as e:
            out["status"] = e.code
            out["final_url"] = e.geturl()
            out["latency_ms"] = int((dt.datetime.now(dt.timezone.utc) - started).total_seconds() * 1000)
            out["ok"] = e.code == 200
            out["error"] = f"HTTP {e.code}"
            last_err = out["error"]
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}: {e}"
            out["status"] = None
            out["ok"] = False
            out["error"] = last_err
        if attempt < PROBE_RETRIES:
            time.sleep(1.5 * (attempt + 1))
    return out


def project_urls(p: dict) -> list[tuple[str, str]]:
    """(role, url) pairs to probe for a project, de-duplicated."""
    pairs = []
    seen = set()

    def add(role, u):
        if u and u not in seen:
            seen.add(u)
            pairs.append((role, u))

    add("live", p.get("live_url"))
    for dm in p.get("demos") or []:
        add("demo", dm.get("url"))
    return pairs


def fetch_repos() -> dict:
    """Return {repo_name: pushed_at_iso} for the account, or {} on failure."""
    out = {}
    page = 1
    try:
        while True:
            url = (
                f"https://api.github.com/users/{USER}/repos"
                f"?per_page=100&page={page}&sort=full_name"
            )
            req = urllib.request.Request(url, headers=auth_headers())
            with urllib.request.urlopen(req, timeout=30) as r:
                chunk = json.load(r)
            if not chunk:
                break
            for repo in chunk:
                if repo.get("fork"):
                    continue
                out[repo["name"]] = repo.get("pushed_at")
            if len(chunk) < 100:
                break
            page += 1
    except Exception as e:  # noqa: BLE001
        log(f"!! recency fetch failed: {type(e).__name__}: {e}")
        return {}
    return out


def rebuild_groups(data: dict) -> None:
    """projects.json carries a second, grouped copy the frontend reads; keep it in sync."""
    order = data.get("category_order") or []
    cats = [c for c in order]
    for p in data["projects"]:
        c = p.get("category")
        if c and c not in cats:
            cats.append(c)
    groups = []
    for cat in cats:
        items = [p for p in data["projects"] if p.get("category") == cat]
        if items:
            groups.append({"category": cat, "projects": items})
    data["groups"] = groups


def repo_names(p: dict) -> list[str]:
    repo = p.get("repo")
    if isinstance(repo, list):
        return [r for r in repo if r]
    return [repo] if repo else []


def recency_for(p: dict, repos: dict) -> str | None:
    stamps = [repos.get(name) for name in repo_names(p)]
    stamps = [s for s in stamps if s]
    return max(stamps) if stamps else None


def build_status(data: dict, results: dict, checked_at: str) -> dict:
    projects = {}
    failures = []
    for p in data["projects"]:
        key = p["key"]
        entry = results.get(key, {})
        live = entry.get("live") or {}
        if not live:
            continue
        demos = entry.get("demos") or []
        projects[key] = {
            "title": p.get("display_title") or key,
            "url": live.get("url"),
            "ok": live.get("ok", False),
            "status": live.get("status"),
            "latency_ms": live.get("latency_ms"),
            "final_url": live.get("final_url"),
            "error": live.get("error"),
            "demos": demos,
        }
        for res in [live, *demos]:
            if not res.get("ok"):
                failures.append({
                    "key": key,
                    "role": res.get("role"),
                    "url": res.get("url"),
                    "status": res.get("status"),
                    "error": res.get("error"),
                })
    down = sorted(k for k, v in projects.items() if not v["ok"])
    total = len(projects)
    ok = total - len(down)
    return {
        "checked_at": checked_at,
        "status": "ok" if not failures else "degraded",
        "live_total": total,
        "live_ok": ok,
        "live_down": len(down),
        "down_keys": down,
        "failed": failures,
        "projects": projects,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="always rewrite outputs")
    ap.add_argument("--only", nargs="*", default=None, help="limit to these keys")
    ap.add_argument("--no-recents", action="store_true", help="skip GitHub recency lookups")
    args = ap.parse_args()

    data = json.loads(PROJECTS.read_text())
    projects = data["projects"]
    if args.only:
        projects = [p for p in projects if p["key"] in set(args.only)]
    else:
        projects = list(projects)

    to_probe = [p for p in projects if project_urls(p)]

    checked_at = now_iso()
    results: dict = {}

    def work(p: dict):
        entry = {"live": None, "demos": []}
        for role, url in project_urls(p):
            res = probe(url)
            res["role"] = role
            if role == "live" or entry["live"] is None:
                entry["live"] = res
            else:
                entry["demos"].append(res)
        return p["key"], entry

    with futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        for key, entry in ex.map(work, to_probe):
            results[key] = entry

    repos = {} if args.no_recents else fetch_repos()

    # Detect meaningful changes (status / recency / project set).
    changed = False
    previous = {p["key"]: p for p in data["projects"]}
    for p in projects:
        key = p["key"]
        entry = results.get(key, {})
        live = entry.get("live") or {}
        if live:
            new_pairs = {
                "live_ok": bool(live["ok"]),
                "live_status": live["status"],
                "live_checked_at": checked_at,
                "live_latency_ms": live["latency_ms"],
                "live_final_url": live.get("final_url"),
                "live_error": live.get("error"),
            }
        else:
            new_pairs = {
                "live_ok": None,
                "live_status": None,
                "live_checked_at": None,
                "live_latency_ms": None,
                "live_final_url": None,
                "live_error": None,
            }
        if not args.no_recents:
            new_pairs["updated_at"] = recency_for(p, repos) if repos else p.get("updated_at")
        # Volatile fields must not force a rewrite on their own; only a status or
        # recency change is worth a commit.
        volatile = {"live_checked_at", "live_latency_ms"}
        old = previous.get(key, {})
        for field, value in new_pairs.items():
            if field in volatile:
                continue
            if old.get(field) != value:
                changed = True
        p.update(new_pairs)

    if not args.only:
        rebuild_groups(data)

    status = build_status(data, results, checked_at)
    health = {
        "checked_at": status["checked_at"],
        "status": status["status"],
        "live_total": status["live_total"],
        "live_ok": status["live_ok"],
        "live_down": status["live_down"],
        "down_keys": status["down_keys"],
    }
    prev_health = data.get("health") or {}
    if prev_health.get("status") != health["status"] or prev_health.get("live_down") != health["live_down"]:
        changed = True
    data["health"] = health

    # Report.
    failures = status["failed"]
    log(f"checked {status['live_total']} live URLs at {checked_at}: "
        f"{status['live_ok']} ok, {status['live_down']} project(s) down")
    for f in failures:
        log(f"!! DOWN {f['key']} [{f['role']}]: {f['url']} -> {f['status']} {f.get('error') or ''}")

    write = args.force or changed
    if write:
        data["count"] = len(data["projects"])
        data["live_count"] = sum(1 for p in data["projects"] if p.get("has_live_demo"))
        PROJECTS.write_text(json.dumps(data, indent=2) + "\n")
        STATUS.write_text(json.dumps(status, indent=2) + "\n")
        log(f"wrote {PROJECTS.name} and {STATUS.name} (changed={changed})")
    else:
        log("no status/recency change; outputs left untouched")

    log(f"CHANGED={'1' if changed else '0'} DOWN={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
