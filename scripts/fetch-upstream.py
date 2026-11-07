#!/usr/bin/env python3
"""Download the live Party Quiz web client into a scratch folder.

The client at https://partyquiz.club is a static bundle: one HTML page, a
handful of CSS/JS files, 18 lang.json dictionaries and the stock avatar art.
This script walks that bundle (HTML -> CSS/JS references -> CSS url() assets)
and writes a mirror into ``_upstream/`` so a maintainer can diff it against
the copy shipped in this repository.

Usage:
    python3 scripts/fetch-upstream.py                # full snapshot
    python3 scripts/fetch-upstream.py --out _upstream

The directory is git-ignored on purpose: it is input for a review, not
something that should be committed as-is.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://partyquiz.club"
UA = "PQRevamped-upstream-sync/1.0 (+https://github.com/muxira/PQRevamped)"

LANGS = [
    "arabic", "czech", "english", "french", "german", "italian", "japanese",
    "kazakh", "korean", "polish", "portuguese", "russian",
    "simplifiedchinese", "spanish", "spanishlatinamerica", "swedish",
    "turkish", "ukrainian",
]

SEEDS = [
    "/",
    "/core/templates/game.html",
    "/core/templates/js/i18n.js",
    "/core/templates/js/avatars_list.js",
    "/core/templates/js/jquery_min.js",
    "/js/language_load.js",
    "/favicon.ico",
    "/manifest.json",
    "/manifest.webmanifest",
    "/browserconfig.xml",
    # Assets the client asks for at runtime, so they never show up in game.html.
    "/assets/party_quiz_logo_wordmark.png",
    "/assets/video-camera.png",
    "/assets/custom_avatar_background.png",
    "/assets/fonts/party-quiz-sans-400.woff2",
    "/assets/fonts/party-quiz-sans-400.ttf",
    "/assets/fonts/party-quiz-sans-700.woff2",
    "/assets/fonts/party-quiz-sans-700.ttf",
    "/localized/english/lang.json",
]

TEXT_EXT = {".html", ".css", ".js", ".json", ".webmanifest", ".xml", ".svg"}

# Sound reactions and other runtime media are megabytes each and change every release,
# so mirroring them turned a one-minute diff into an hour-long download. The bundle is
# reviewed for markup, styles and logic; bytes that never enter this repo are skipped.
MEDIA_EXT = {
    ".mp3", ".ogg", ".oga", ".wav", ".m4a", ".aac", ".flac", ".opus",
    ".mp4", ".webm", ".mov", ".mkv", ".avi",
}
MAX_BYTES = 2 * 1024 * 1024
WORKERS = 10
TIMEOUT = 20
ASSET_RE = re.compile(
    r"""(?:src|href)\s*=\s*["']([^"'#]+)["']|"""
    r"""url\(\s*["']?([^"')]+)["']?\s*\)|"""
    r"""["']((?:\.{0,2}/)?(?:assets|localized|avatars|core)/[^"'\s)]+)["']"""
)
FALLBACK_RE = re.compile(r"^\s*<!DOCTYPE html", re.I)
FALLBACK_TITLE = "Choose your language to begin"


def fetch(path: str) -> tuple[bytes, str, int]:
    """One file. Two attempts and a 20 s ceiling: a mirror that stalls on a single slow
    object is worse than one that reports the miss and moves on."""
    url = BASE + path
    last = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                body = res.read(MAX_BYTES + 1)
                ctype = res.headers.get("Content-Type", "")
                if len(body) > MAX_BYTES:
                    return b"", ctype, 413
                return body, ctype, 200
        except urllib.error.HTTPError as exc:
            return b"", exc.headers.get("Content-Type", ""), exc.code
        except Exception as exc:  # noqa: BLE001 - network flake, retry once
            last = exc
            time.sleep(1.0)
    print(f"  !! {path}: {last}", file=sys.stderr)
    return b"", "", 0


def normalise(raw: str, page: str) -> str | None:
    raw = raw.strip()
    if not raw or raw.startswith(("data:", "mailto:", "javascript:", "#")):
        return None
    if raw.startswith(("http://", "https://")):
        if "partyquiz.club" not in raw:
            return None
        raw = urllib.parse.urlsplit(raw).path
    if raw.startswith("//"):
        return None
    base = BASE + page if not page.endswith("/") else BASE + page
    resolved = urllib.parse.urljoin(base, raw)
    path = urllib.parse.urlsplit(resolved).path
    if not path.startswith("/"):
        return None
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="_upstream")
    args = parser.parse_args()
    out = args.out
    os.makedirs(out, exist_ok=True)

    queue: list[str] = list(SEEDS)
    queue += [f"/localized/{lang}/lang.json" for lang in LANGS]
    queue += [f"/core/templates/css/{name}.css" for name in (
        "reset", "pwa", "input", "normalize", "index", "styles", "popup",
        "mobile-ux", "pq-tokens", "pq-components", "pq-screens",
    )]
    queue.append("/core/templates/js/avatars_list.js")

    seen: set[str] = set()
    files: dict[str, dict] = {}
    skipped_media: list[str] = []
    round_no = 0
    while queue and round_no < 6:
        round_no += 1
        next_round: list[str] = []

        # Deduplicate and drop what this run has no business downloading before a single
        # request goes out; the client's runtime media list is long and totally serial
        # downloads of it used to dominate the whole capture.
        batch: list[str] = []
        for path in queue:
            path = urllib.parse.unquote(path)
            if path in seen or path.endswith("/") or "." not in os.path.basename(path):
                continue
            seen.add(path)
            if os.path.splitext(path)[1].lower() in MEDIA_EXT:
                skipped_media.append(path)
                continue
            batch.append(path)

        print(f"round {round_no}: {len(batch)} candidate(s)"
              + (f", {len(skipped_media)} media file(s) skipped so far" if skipped_media else ""))

        def work(path: str) -> tuple[str, bytes, str, int]:
            body, ctype, status = fetch(path)
            return path, body, ctype, status

        results = []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for item in pool.map(work, batch):
                results.append(item)

        for path, body, ctype, status in results:
            is_text = os.path.splitext(path)[1].lower() in TEXT_EXT
            text = body.decode("utf-8", "replace") if is_text else ""
            fallback = is_text and path not in ("/", "/core/templates/game.html") and (
                FALLBACK_RE.match(text) or FALLBACK_TITLE in text
            )
            if status != 200 or not body or fallback:
                note = "(spa fallback)" if fallback else ("(too big)" if status == 413 else "")
                print(f"  -- {path} -> {status} {ctype} {note}")
                files[path] = {"status": status, "skipped": True, "content_type": ctype}
                continue

            rel = "index.html" if path == "/" else path.lstrip("/")
            dest = os.path.join(out, rel)
            try:
                os.makedirs(os.path.dirname(dest) or out, exist_ok=True)
                with open(dest, "wb") as fh:
                    fh.write(body)
            except OSError as exc:
                print(f"  !! {path}: {exc}", file=sys.stderr)
                continue
            digest = hashlib.sha256(body).hexdigest()
            files[path] = {
                "status": status,
                "size": len(body),
                "sha256": digest,
                "content_type": ctype,
            }
            print(f"  ok {path} ({len(body)} B)")

            if is_text:
                for match in ASSET_RE.finditer(text):
                    raw = next((g for g in match.groups() if g), None)
                    if not raw:
                        continue
                    resolved = normalise(raw, path)
                    if resolved and resolved not in seen:
                        next_round.append(resolved)

        # Avatars are listed inside avatars_list.js rather than linked.
        avatars_path = os.path.join(out, "core/templates/js/avatars_list.js")
        if os.path.exists(avatars_path):
            with open(avatars_path, encoding="utf-8", errors="replace") as fh:
                names = re.findall(r"'([A-Za-z0-9_]+\.png)'", fh.read())
            for name in names:
                url = f"/avatars/{name}"
                if url not in seen:
                    next_round.append(url)

        queue = sorted(set(next_round))

    payload = {
        "base": BASE,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "skipped_media": sorted(set(skipped_media)),
        "files": dict(sorted(files.items())),
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")

    ok = sum(1 for meta in files.values() if not meta.get("skipped"))
    print(f"\n{ok}/{len(files)} files saved to {out}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
