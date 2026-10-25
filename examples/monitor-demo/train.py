"""Synthetic epoch metrics so the monitoring charts have something to draw.

Picks up dataset.txt when a pipeline step wrote one into $CILITRAIN_OUTPUT.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

OUT = Path(os.environ.get("CILITRAIN_OUTPUT", "/output"))
OUT.mkdir(parents=True, exist_ok=True)
EPOCHS = int(os.environ.get("CILITRAIN_EPOCHS", "7"))

dataset = OUT / "dataset.txt"
rows = None
if dataset.exists():
    rows = max(0, len(dataset.read_text(encoding="utf-8").splitlines()) - 1)
    print(f"metrics rows={rows}", flush=True)
    print(f"[cilitrain] loaded shared dataset rows: {rows}", flush=True)
else:
    print("[cilitrain] no dataset.txt (standalone run)", flush=True)

history: list[dict] = []
for epoch in range(1, EPOCHS + 1):
    loss = max(0.05, 1.2 * math.exp(-0.35 * epoch) + 0.02)
    acc = min(0.99, 1 - loss)
    print(f"metrics epoch={epoch} loss={loss:.4f} acc={acc:.4f}", flush=True)
    history.append({"epoch": epoch, "loss": loss, "acc": acc})
    time.sleep(1)

payload = {
    "accuracy": history[-1]["acc"],
    "loss": history[-1]["loss"],
    "epochs": len(history),
    "history": history,
}
if rows is not None:
    payload["dataset_rows"] = rows
(OUT / "metrics.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
(OUT / "summary.txt").write_text(
    f"final acc={payload['accuracy']:.4f}\n", encoding="utf-8"
)
print(f"score {payload['accuracy']:.4f}", flush=True)
print("[cilitrain] done", flush=True)
