"""Paste-and-run starter for CiliTrain custom jobs.

Print `metrics epoch=N key=value` for charts.
Write files under $CILITRAIN_OUTPUT (metrics.json, etc.).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

OUT = Path(os.environ.get("CILITRAIN_OUTPUT", "/output"))
OUT.mkdir(parents=True, exist_ok=True)

print("metrics epoch=1 loss=1.0000", flush=True)

payload = {
    "loss": 1.0,
    "epochs": 1,
    "history": [{"epoch": 1, "loss": 1.0}],
}
(OUT / "metrics.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
print("score 1.0", flush=True)
print("[cilitrain] done", flush=True)
