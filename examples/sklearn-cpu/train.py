"""Tiny scikit-learn fit for CiliTrain CPU jobs.

Writes metrics.json + score.txt + model.joblib under $CILITRAIN_OUTPUT.
Hyperparameters come from CILITRAIN_C / CILITRAIN_MAX_ITER / CILITRAIN_TEST_SIZE.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import joblib
from sklearn.datasets import load_iris
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

OUT = Path(os.environ.get("CILITRAIN_OUTPUT", "/output"))
OUT.mkdir(parents=True, exist_ok=True)
C = float(os.environ.get("CILITRAIN_C", "1.0"))
MAX_ITER = int(os.environ.get("CILITRAIN_MAX_ITER", "200"))
TEST_SIZE = float(os.environ.get("CILITRAIN_TEST_SIZE", "0.25"))

print("[cilitrain] loading iris...", flush=True)
X, y = load_iris(return_X_y=True)
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=TEST_SIZE, random_state=42)

print(f"[cilitrain] C={C} max_iter={MAX_ITER} test_size={TEST_SIZE}", flush=True)
print("metrics epoch=0 loss=1.0 acc=0.0", flush=True)
clf = LogisticRegression(C=C, max_iter=MAX_ITER).fit(Xtr, ytr)
acc = float(clf.score(Xte, yte))
loss = float(1 - acc)
print(f"metrics epoch=1 loss={loss:.4f} acc={acc:.4f}", flush=True)

history = [
    {"epoch": 0, "loss": 1.0, "acc": 0.0},
    {"epoch": 1, "loss": loss, "acc": acc},
]
(OUT / "score.txt").write_text(str(acc), encoding="utf-8")
joblib.dump({"model": clf, "classes": list(load_iris().target_names)}, OUT / "model.joblib")
(OUT / "metrics.json").write_text(
    json.dumps(
        {
            "accuracy": acc,
            "score": acc,
            "loss": loss,
            "model": "LogisticRegression",
            "dataset": "iris",
            "hyperparams": {"c": C, "max_iter": MAX_ITER, "test_size": TEST_SIZE},
            "history": history,
        },
        indent=2,
    ),
    encoding="utf-8",
)
print(f"score {acc:.4f}", flush=True)
print("[cilitrain] done", flush=True)
