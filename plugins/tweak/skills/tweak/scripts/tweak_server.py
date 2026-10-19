#!/usr/bin/env python3
"""Tweak server.

Serves an HTML prototype with the tweak panel injected (the file on disk is not
touched while you play), and writes the baked result back when you press
"Сохранить в файл" in the panel. Standard library only, Python 3.7+.

    python3 tweak_server.py path/to/page.html [--root DIR] [--port 8765] [--no-open]
"""
import argparse
import json
import shutil
import sys
import webbrowser
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

PANEL = Path(__file__).resolve().parent.parent / "assets" / "tweak-panel.js"
INJECT = b'<script src="/__tweak/panel.js" data-tweak-panel></script>\n'
HTML_EXT = {".html", ".htm"}
WRITABLE_EXT = HTML_EXT | {".css"}
BACKUP_DIR = ".tweak-backups"


class Handler(SimpleHTTPRequestHandler):
    root = Path(".")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console for TWEAK_* events only
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _resolve(self, rel):
        p = (self.root / rel.lstrip("/")).resolve()
        if p != self.root and self.root not in p.parents:
            return None
        return p

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)

        if path == "/__tweak/panel.js":
            return self._send(200, PANEL.read_bytes(), "text/javascript; charset=utf-8")

        if path.startswith("/__tweak/raw/"):
            p = self._resolve(path[len("/__tweak/raw/"):])
            if not p or not p.is_file():
                return self._send(404, b"not found", "text/plain; charset=utf-8")
            return self._send(200, p.read_bytes(), "text/plain; charset=utf-8")

        p = self._resolve(path)
        if p and p.is_dir() and path.endswith("/") and (p / "index.html").is_file():
            p = p / "index.html"
        if p and p.is_file() and p.suffix.lower() in HTML_EXT:
            data = p.read_bytes()
            i = data.lower().rfind(b"</body>")
            data = data[:i] + INJECT + data[i:] if i >= 0 else data + INJECT
            return self._send(200, data, "text/html; charset=utf-8")

        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/__tweak/bake":
            return self._json(404, {"ok": False, "error": "not found"})
        # Custom header forces a CORS preflight, so other sites can't post here.
        if self.headers.get("X-Tweak") != "1":
            return self._json(403, {"ok": False, "error": "forbidden"})
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            files = payload["files"]
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"ok": False, "error": "bad payload"})

        targets = []
        for f in files:
            p = self._resolve(str(f.get("path", "")))
            if not p or not p.is_file() or p.suffix.lower() not in WRITABLE_EXT:
                return self._json(400, {"ok": False, "error": "нельзя записать: %s" % f.get("path")})
            targets.append((p, f.get("content", "")))

        backup = self.root / BACKUP_DIR / datetime.now().strftime("%Y%m%d-%H%M%S")
        written = []
        for p, content in targets:
            rel = p.relative_to(self.root)
            dst = backup / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
            p.write_text(content, encoding="utf-8")
            written.append(str(rel))

        backup_rel = str(backup.relative_to(self.root))
        print("TWEAK_BAKED %s (backup: %s)" % (", ".join(written), backup_rel), flush=True)
        self._json(200, {"ok": True, "files": written, "backup": backup_rel})


def main():
    ap = argparse.ArgumentParser(description="Live tweak panel for an HTML prototype")
    ap.add_argument("file", help="HTML file to open")
    ap.add_argument("--root", help="folder to serve (default: the file's folder); use when the page loads ../assets")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    args = ap.parse_args()

    page = Path(args.file).expanduser().resolve()
    if not page.is_file():
        sys.exit("Файл не найден: %s" % page)
    root = Path(args.root).expanduser().resolve() if args.root else page.parent
    if root not in page.parents:
        sys.exit("Файл должен лежать внутри --root")
    Handler.root = root

    server = None
    for port in range(args.port, args.port + 50):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(root)))
            break
        except OSError:
            continue
    if server is None:
        sys.exit("Нет свободного порта")

    url = "http://127.0.0.1:%d/%s" % (server.server_address[1], quote(str(page.relative_to(root))))
    print("TWEAK_URL %s" % url, flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
