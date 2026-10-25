"""Classify iris flowers with a registered model.

Reads model.joblib from $CILITRAIN_MODEL_DIR. One flower comes from
$CILITRAIN_INFER_INPUT (JSON); a CSV batch comes as JSON lines in the file
named by $CILITRAIN_INFER_BATCH, each {"input": {...}, "extra": {...}}.
Writes prediction.json (and predictions.csv for a batch) under $CILITRAIN_OUTPUT.

Importing this module only loads the model; serve.py calls predict() per request.
"""

from __future__ import annotations

import csv
import json
import os
from collections import Counter
from pathlib import Path

import joblib

MODEL_DIR = Path(os.environ.get("CILITRAIN_MODEL_DIR", "/model"))
OUT = Path(os.environ.get("CILITRAIN_OUTPUT", "/output"))
KEYS = ("sepal_length", "sepal_width", "petal_length", "petal_width")

bundle = joblib.load(MODEL_DIR / "model.joblib")
clf, classes = bundle["model"], bundle["classes"]
names = [str(classes[int(c)]) for c in clf.classes_]


def classify(rows: list[dict]) -> list[dict]:
    probs = clf.predict_proba([[float(r[k]) for k in KEYS] for r in rows])
    out = []
    for p in probs:
        by_class = {n: round(float(v), 4) for n, v in zip(names, p)}
        label = max(by_class, key=by_class.get)
        out.append({"label": label, "probabilities": by_class})
    return out


def predict(inp: dict) -> dict:
    return {"type": "classification", **classify([inp])[0]}


def run_batch(batch: str) -> None:
    items = [json.loads(line) for line in Path(batch).read_text(encoding="utf-8").splitlines() if line.strip()]
    print(f"[cilitrain] batch of {len(items)} rows", flush=True)
    preds = classify([it["input"] for it in items])
    extras = list(items[0]["extra"]) if items else []
    with (OUT / "predictions.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow([*extras, *KEYS, "label", "confidence", *(f"prob_{n}" for n in names)])
        for it, p in zip(items, preds):
            probs = p["probabilities"]
            w.writerow(
                [*(it["extra"].get(k, "") for k in extras), *(it["input"][k] for k in KEYS),
                 p["label"], probs[p["label"]], *(probs[n] for n in names)]
            )
    summary = {
        "type": "batch",
        "output": "classification",
        "rows": len(items),
        "counts": dict(Counter(p["label"] for p in preds)),
        "file": "predictions.csv",
        "sample": [
            {"input": it["input"], "label": p["label"], "confidence": p["probabilities"][p["label"]]}
            for it, p in zip(items[:5], preds[:5])
        ],
    }
    (OUT / "prediction.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"[cilitrain] class counts {summary['counts']}", flush=True)
    print("[cilitrain] wrote", OUT / "predictions.csv", flush=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    batch = os.environ.get("CILITRAIN_INFER_BATCH")
    if batch:
        run_batch(batch)
    else:
        inp = json.loads(os.environ.get("CILITRAIN_INFER_INPUT", "{}"))
        print(f"[cilitrain] input {dict((k, float(inp[k])) for k in KEYS)}", flush=True)
        pred = predict(inp)
        (OUT / "prediction.json").write_text(json.dumps(pred, indent=2), encoding="utf-8")
        print(f"[cilitrain] predicted {pred['label']} p={pred['probabilities'][pred['label']]:.4f}", flush=True)
    print("[cilitrain] wrote", OUT / "prediction.json", flush=True)


if __name__ == "__main__":
    main()
