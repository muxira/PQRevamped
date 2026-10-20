#!/usr/bin/env python3
"""Tiny static server for the companion.

    python3 scripts/preview.py              # http://localhost:8000
    python3 scripts/preview.py --lan        # also reachable from a phone on the same Wi-Fi
    python3 scripts/preview.py --port 9000

Compared to `python -m http.server` it:
  - sends the right MIME type for .webmanifest / .woff2 / .obj;
  - disables caching, so a reload always picks up an edit;
  - prints the LAN URL you can open on a phone (which is how the mobile layout
    should be tested — a desktop window at 375px is a rough approximation).
"""

from __future__ import annotations

import argparse
import functools
import http.server
import socket
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

EXTRA_TYPES = {
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
    ".obj": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **EXTRA_TYPES}

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # quieter, one line per request
        print(f"  {self.address_string()} {fmt % args}")


def lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--lan", action="store_true", help="bind 0.0.0.0 so a phone can connect")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    handler = functools.partial(Handler, directory=str(ROOT))

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((host, args.port), handler) as server:
        print(f"Party Quiz companion on http://localhost:{args.port}/")
        if args.lan:
            ip = lan_ip()
            if ip:
                print(f"Phone (same Wi-Fi): http://{ip}:{args.port}/core/templates/game.html")
            print("3D Try-On needs a secure context on some browsers; localhost is exempt,")
            print("a LAN IP is not — use a tunnel if the 3D tab refuses to start.")
        print("Ctrl+C to stop\n")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
