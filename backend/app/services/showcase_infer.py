"""Deterministic stand-ins for the inference scripts when no cluster is attached."""

from __future__ import annotations

import csv
import hashlib
import io
import math
from typing import Any

# Per-class feature means of the iris dataset (sepal length/width, petal length/width, cm).
_IRIS_CENTROIDS = {
    "setosa": (5.006, 3.428, 1.462, 0.246),
    "versicolor": (5.936, 2.770, 4.260, 1.326),
    "virginica": (6.588, 2.974, 5.552, 2.026),
}
_IRIS_KEYS = ("sepal_length", "sepal_width", "petal_length", "petal_width")

_PASSAGES = (
    " to be, that is the question:\nWhether 'tis nobler in the mind to suffer\n"
    "The slings and arrows of outrageous fortune,\nOr to take arms against a sea of troubles,\n"
    "And by opposing end them. To die: to sleep;\nNo more; and by a sleep to say we end\n"
    "The heart-ache and the thousand natural shocks\nThat flesh is heir to.",
    "\nHORATIO:\nWhat, has this thing appear'd again to-night?\n\nMARCELLUS:\n"
    "Horatio says 'tis but our fantasy,\nAnd will not let belief take hold of him\n"
    "Touching this dreaded sight, twice seen of us.\n",
    "\nHAMLET:\nO, that this too too solid flesh would melt\nThaw and resolve itself into a dew!\n"
    "Or that the Everlasting had not fix'd\nHis canon 'gainst self-slaughter! O God! God!\n"
    "How weary, stale, flat and unprofitable,\nSeem to me all the uses of this world!",
    "\nPOLONIUS:\nNeither a borrower nor a lender be;\nFor loan oft loses both itself and friend,\n"
    "And borrowing dulls the edge of husbandry.\nThis above all: to thine own self be true,\n"
    "And it must follow, as the night the day,\nThou canst not then be false to any man.",
)


def _classify(inp: dict[str, Any]) -> dict[str, Any]:
    x = [float(inp.get(k, 0.0)) for k in _IRIS_KEYS]
    dist = {
        name: math.sqrt(sum((a - b) ** 2 for a, b in zip(x, c))) for name, c in _IRIS_CENTROIDS.items()
    }
    weights = {name: math.exp(-2.0 * d) for name, d in dist.items()}
    total = sum(weights.values()) or 1.0
    probs = {name: round(w / total, 4) for name, w in weights.items()}
    label = max(probs, key=probs.get)
    return {"type": "classification", "label": label, "probabilities": probs}


def _generate(inp: dict[str, Any]) -> dict[str, Any]:
    prompt = str(inp.get("prompt", ""))
    n = int(inp.get("max_new_tokens", 200))
    temp = float(inp.get("temperature", 0.8))
    if prompt.rstrip().lower().endswith("or not"):
        passage = _PASSAGES[0]
    else:
        seed = hashlib.sha256(f"{prompt}|{temp:.2f}".encode()).digest()[0]
        passage = _PASSAGES[1 + seed % (len(_PASSAGES) - 1)]
    body = (passage * (n // len(passage) + 1))[:n]
    return {"type": "text", "text": prompt + body, "prompt": prompt, "new_tokens": len(body)}


def simulate_prediction(template: str, inp: dict[str, Any]) -> dict[str, Any]:
    if template == "sklearn-cpu":
        return _classify(inp)
    return _generate(inp)


def simulate_batch(template: str, rows: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    """(predictions.csv, prediction.json summary) in the same shape the real infer scripts write."""
    preds = [simulate_prediction(template, r["input"]) for r in rows]
    extras = list(rows[0]["extra"]) if rows else []
    inputs = list(rows[0]["input"]) if rows else []
    buf = io.StringIO()
    writer = csv.writer(buf)
    if template == "sklearn-cpu":
        classes = list(preds[0]["probabilities"]) if preds else []
        writer.writerow([*extras, *inputs, "label", "confidence", *(f"prob_{c}" for c in classes)])
        for r, p in zip(rows, preds):
            probs = p["probabilities"]
            writer.writerow(
                [*(r["extra"][k] for k in extras), *(r["input"][k] for k in inputs), p["label"],
                 probs[p["label"]], *(probs[c] for c in classes)]
            )
        counts: dict[str, int] = {}
        for p in preds:
            counts[p["label"]] = counts.get(p["label"], 0) + 1
        sample = [
            {"input": r["input"], "label": p["label"], "confidence": p["probabilities"][p["label"]]}
            for r, p in zip(rows[:5], preds[:5])
        ]
        summary = {"type": "batch", "output": "classification", "rows": len(rows), "counts": counts}
    else:
        writer.writerow([*extras, *inputs, "generated"])
        for r, p in zip(rows, preds):
            gen = p["text"][len(p["prompt"]):]
            writer.writerow([*(r["extra"][k] for k in extras), *(r["input"][k] for k in inputs), gen])
        sample = [
            {"input": r["input"], "generated": p["text"][len(p["prompt"]):][:160]}
            for r, p in zip(rows[:5], preds[:5])
        ]
        summary = {"type": "batch", "output": "text", "rows": len(rows)}
    return buf.getvalue(), {**summary, "file": "predictions.csv", "sample": sample}


def infer_log_lines(template: str, label: str, done: bool, rows: int | None = None) -> list[str]:
    lines = [f"[cilitrain] simulated inference with {label} (no cluster)", "[cilitrain] model ready"]
    if template == "sklearn-cpu":
        lines.append("[cilitrain] loaded model.joblib")
    else:
        lines += ["[cilitrain] loaded model.pt", "[cilitrain] sampling..."]
    if rows:
        lines.append(f"[cilitrain] batch of {rows} rows")
    if done:
        if rows:
            lines.append("[cilitrain] wrote predictions.csv")
        lines += ["[cilitrain] wrote prediction.json", "[cilitrain] finished"]
    return lines
