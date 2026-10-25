"""HTTP server for an online inference service.

Imports the template's inference module (default `infer`, next to this file),
which loads the model once, then answers:

  GET  /healthz                      -> {"ok": true}
  POST /predict {"input": {...}}     -> {"output": {...}}
  POST /predict {"inputs": [{...}]}  -> {"outputs": [{...}, ...]}

Input validation happens on the platform before a request reaches the pod.
Standard library only, so it runs on whatever image the template uses.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
PORT = int(os.environ.get("CILITRAIN_SERVE_PORT", "8080"))
MAX_BODY = 512 * 1024

started = time.time()
model = importlib.import_module(os.environ.get("CILITRAIN_INFER_MODULE", "infer"))
lock = threading.Lock()
print(f"[cilitrain] model loaded in {time.time() - started:.1f}s; serving on :{PORT}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/healthz":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/predict":
            self._send(404, {"error": "not found"})
            return
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_BODY:
            self._send(413, {"error": "request body too large"})
            return
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "body is not JSON"})
            return
        t0 = time.time()
        try:
            with lock:
                if isinstance(body.get("inputs"), list):
                    out = {"outputs": [model.predict(x) for x in body["inputs"]]}
                else:
                    out = {"output": model.predict(body.get("input") or {})}
        except Exception as exc:  # noqa: BLE001
            print(f"[cilitrain] predict failed: {exc}", flush=True)
            self._send(500, {"error": str(exc)[:300]})
            return
        print(f"[cilitrain] predict ok in {(time.time() - t0) * 1000:.0f}ms", flush=True)
        self._send(200, out)

    def log_message(self, fmt: str, *args) -> None:
        if "/healthz" not in (args[0] if args else ""):
            sys.stdout.write(f"[http] {fmt % args}\n")


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
