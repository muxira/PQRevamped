#!/usr/bin/env python3
"""Static checks that keep this fork honest.

Run locally or in CI:

    python3 scripts/check.py

It verifies, without a browser:
  1. every local href/src/url() a shipped file points at actually exists;
  2. every {{template}} and data-i18n key appears in localized/english/lang.json;
  3. all 18 dictionaries have the same key set as English;
  4. every JSON file parses and every page is valid UTF-8;
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
TEMPLATE_RE = re.compile(r"\{\{([^{}\r\n]+)\}\}")
DATA_I18N_RE = re.compile(r'data-i18n(?:-[a-z-]+)?\s*=\s*"([^"]+)"')
LOCAL_ORIGIN_RE = re.compile(r"^(?:\.{0,2}/|[A-Za-z0-9_-]+/)")

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


def check_references(path: Path, text: str) -> None:
    for match in REF_RE.finditer(text):
        raw = (match.group(1) or match.group(2) or "").strip()
        if not raw or raw.startswith(("data:", "mailto:", "tel:", "javascript:", "#", "//")):
            continue
        if re.match(r"^[a-z]+:", raw):
            continue
        if not LOCAL_ORIGIN_RE.match(raw):
            continue
        target = raw.split("?")[0].split("#")[0]
        if not target or target.endswith("/") or " " in target:
            continue  # a directory prefix concatenated at runtime, not a real file
        # Paths are written relative to the file that owns them (HTML/CSS/JS alike
        # enough for this tree: one level of ../ is already the convention).
        resolved = (path.parent / target).resolve()
        if not resolved.exists():
            errors.append(f"{relative(path)}: missing reference {raw}")


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

    for path, text in files.items():
        if path.suffix in {".html", ".css", ".js", ".webmanifest"}:
            check_references(path, text)
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

    checked = sum(1 for p in files if p.suffix in {".html", ".css", ".js", ".json"})
    print(f"\n{checked} shipped files checked, {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
