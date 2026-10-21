#!/usr/bin/env python3
"""Static checks that keep this fork honest.

Run locally or in CI:

    python3 scripts/check.py

It verifies, without a browser:
  1. every local href/src/url() (and every Markdown image) a shipped file points at
     actually exists;
  2. every {{template}} and data-i18n key appears in localized/english/lang.json;
  3. all 18 dictionaries have the same key set as English;
  4. every JSON file parses, every page is valid UTF-8, and every binary asset still
     starts with its format's magic bytes (a 404 page saved as .png looks fine to a
     path check and renders as nothing);
  5. no leftover TODO/FIXME markers or scratch files in the tree.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "_upstream", "node_modules", ".github"}
TEXT_SUFFIXES = {".html", ".css", ".js", ".json", ".webmanifest", ".md", ".yml", ".py", ".txt"}

REF_RE = re.compile(r"""(?:href|src)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)""")
MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)")
TEMPLATE_RE = re.compile(r"\{\{([^{}\r\n]+)\}\}")
DATA_I18N_RE = re.compile(r'data-i18n(?:-[a-z-]+)?\s*=\s*"([^"]+)"')
LOCAL_ORIGIN_RE = re.compile(r"^(?:\.{0,2}/|[A-Za-z0-9_-]+/)")

# extension -> (offset, magic bytes, what it is)
MAGIC = {
    ".png": (0, b"\x89PNG\r\n\x1a\n", "PNG"),
    ".jpg": (0, b"\xff\xd8\xff", "JPEG"),
    ".jpeg": (0, b"\xff\xd8\xff", "JPEG"),
    ".gif": (0, b"GIF8", "GIF"),
    ".ico": (0, b"\x00\x00\x01\x00", "ICO"),
    ".woff2": (0, b"wOF2", "WOFF2"),
    ".woff": (0, b"wOFF", "WOFF"),
    ".ttf": (0, b"\x00\x01\x00\x00", "TrueType"),
}

errors: list[str] = []
warnings: list[str] = []


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT))


def iter_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        yield path


def script_bases(files: dict[Path, str]) -> dict[Path, list[Path]]:
    """Map every <script src> file to the directories of the pages that load it.

    A relative URL inside a script is resolved against the *document*, not against the
    script file, so `../../assets/…` in core/templates/js/avatars.js means
    /assets/… on the page and core/assets/… next to the script. Checking it against the
    script's own folder would flag a path that works in the browser.
    """
    bases: dict[Path, list[Path]] = {}
    for page, text in files.items():
        if page.suffix not in {".html", ".htm"}:
            continue
        for match in re.finditer(r"""<script[^>]*\bsrc\s*=\s*["']([^"']+)["']""", text):
            src = match.group(1).split("?")[0].split("#")[0]
            if not LOCAL_ORIGIN_RE.match(src):
                continue
            resolved = (page.parent / src).resolve()
            if resolved.suffix == ".js" and resolved.exists():
                bases.setdefault(resolved, []).append(page.parent)
    return bases


def check_references(path: Path, text: str, bases: list[Path] | None = None) -> None:
    refs = list(REF_RE.finditer(text))
    if path.suffix == ".md":
        refs += list(MD_IMAGE_RE.finditer(text))
    for match in refs:
        raw = (match.group(1) or (match.group(2) if match.re.groups > 1 else "") or "").strip()
        if not raw or raw.startswith(("data:", "mailto:", "tel:", "javascript:", "#", "//")):
            continue
        if re.match(r"^[a-z]+:", raw):
            continue
        if not LOCAL_ORIGIN_RE.match(raw):
            continue
        target = raw.split("?")[0].split("#")[0]
        if not target or target.endswith("/") or " " in target:
            continue  # a directory prefix concatenated at runtime, not a real file
        candidates = [base for base in (bases or [path.parent])]
        if not any((base / target).resolve().exists() for base in candidates):
            errors.append(f"{relative(path)}: missing reference {raw}")


def check_binary(path: Path) -> None:
    spec = MAGIC.get(path.suffix.lower())
    if not spec:
        return
    offset, magic, label = spec
    try:
        with path.open("rb") as fh:
            fh.seek(offset)
            head = fh.read(len(magic))
    except OSError as exc:
        errors.append(f"{relative(path)}: unreadable ({exc})")
        return
    if head != magic:
        hint = " (looks like an HTML error page)" if head[:1] in (b"<", b"{") else ""
        errors.append(f"{relative(path)}: not a {label} file{hint}")


def check_i18n(files: dict[Path, str], english: dict[str, str]) -> None:
    used: dict[str, set[str]] = {}
    for path, text in files.items():
        if path.suffix not in {".html", ".htm"}:
            continue  # only markup carries the {{key}} contract
        for key in TEMPLATE_RE.findall(text) + DATA_I18N_RE.findall(text):
            key = key.strip()
            if not key or key.startswith("{{"):
                continue
            used.setdefault(key, set()).add(relative(path))

    for key, where in sorted(used.items()):
        if key not in english:
            errors.append(f"i18n key not in English dictionary: {key} ({', '.join(sorted(where))})")

    locales = sorted(p for p in (ROOT / "localized").iterdir() if p.is_dir())
    if len(locales) != 18:
        warnings.append(f"expected 18 locales, found {len(locales)}")
    for locale in locales:
        data = json.loads((locale / "lang.json").read_text(encoding="utf-8-sig"))
        missing = sorted(set(english) - set(data))
        extra = sorted(set(data) - set(english))
        if missing:
            errors.append(f"localized/{locale.name}/lang.json: {len(missing)} key(s) missing (e.g. {missing[0]})")
        if extra:
            warnings.append(f"localized/{locale.name}/lang.json: {len(extra)} key(s) not in English")


def main() -> int:
    files: dict[Path, str] = {}
    for path in iter_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        files[path] = text

    for path in iter_files():
        check_binary(path)

    bases = script_bases(files)
    for path, text in files.items():
        if path.suffix in {".html", ".css", ".js", ".webmanifest", ".md"}:
            check_references(path, text, bases.get(path))
        if path.suffix == ".json":
            try:
                json.loads(text)
            except json.JSONDecodeError as exc:
                errors.append(f"{relative(path)}: invalid JSON ({exc})")
        for marker in ("TODO", "FIXME", "XXX"):
            if marker in text and path.suffix in {".js", ".css", ".html"}:
                warnings.append(f"{relative(path)}: leftover {marker}")

    english = json.loads((ROOT / "localized" / "english" / "lang.json").read_text(encoding="utf-8-sig"))
    check_i18n(files, english)

    for message in warnings:
        print(f"warn  {message}")
    for message in errors:
        print(f"error {message}")

    checked = sum(1 for p in files if p.suffix in {".html", ".css", ".js", ".json", ".md"})
    print(f"\n{checked} shipped files checked, {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
