"""Training metrics: metrics.json + log parsing (MLflow-style key=value lines)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app.services.artifacts import list_local_artifacts, metrics_path, read_local_artifact

# metrics epoch=1 loss=0.42 acc=0.91
LINE_RE = re.compile(
    r"(?:metrics\s+)?(?:epoch[=:\s]+(?P<epoch>\d+)\s+)?(?P<body>(?:[a-zA-Z_][\w]*=[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?\s*)+)",
    re.IGNORECASE,
)
KV_RE = re.compile(r"([a-zA-Z_][\w]*)=([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)")
SCORE_RE = re.compile(r"\bscore[=:\s]+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)", re.IGNORECASE)


def parse_log_metrics(logs: str) -> list[dict[str, Any]]:
    series: list[dict[str, Any]] = []
    for line in logs.splitlines():
        # strip optional k8s timestamp prefix
        content = re.sub(r"^\S+\s+", "", line) if re.match(r"^\d{4}-", line) else line
        m = LINE_RE.search(content)
        if not m:
            sm = SCORE_RE.search(content)
            if sm:
                series.append({"score": float(sm.group(1))})
            continue
        point: dict[str, Any] = {}
        if m.group("epoch") is not None:
            point["epoch"] = int(m.group("epoch"))
        for k, v in KV_RE.findall(m.group("body")):
            try:
                point[k] = float(v)
            except ValueError:
                continue
        if point:
            series.append(point)
    return series


def load_metrics_json(run_id: str) -> dict[str, Any] | None:
    # prefer collected artifact
    try:
        p = read_local_artifact(run_id, "metrics.json")
        return json.loads(p.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    mp = metrics_path(run_id)
    if mp.exists():
        try:
            return json.loads(mp.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
    return None


def save_metrics(run_id: str, payload: dict[str, Any]) -> None:
    metrics_path(run_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build_metrics_view(run_id: str, logs: str = "") -> dict[str, Any]:
    final = load_metrics_json(run_id) or {}
    # if metrics.json was collected as artifact with nested content
    series = parse_log_metrics(logs)
    # merge artifact metrics.json scalar fields
    if not final:
        for art in list_local_artifacts(run_id):
            if art["path"].endswith("metrics.json"):
                try:
                    final = json.loads(read_local_artifact(run_id, art["path"]).read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    pass
    # derive summary
    summary: dict[str, Any] = {}
    if isinstance(final, dict):
        for k, v in final.items():
            if isinstance(v, (int, float)) and k != "history":
                summary[k] = v
        if isinstance(final.get("history"), list):
            series = final["history"] + series
    if series:
        last = series[-1]
        for k, v in last.items():
            if k != "epoch" and isinstance(v, (int, float)) and k not in summary:
                summary[k] = v
    # keys for charting
    chart_keys = sorted(
        {k for pt in series for k in pt.keys() if k != "epoch" and isinstance(pt.get(k), (int, float))}
    )
    return {
        "summary": summary,
        "series": series,
        "chart_keys": chart_keys,
        "final": final,
        "artifacts": list_local_artifacts(run_id),
    }


def compare_metrics(views: list[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    keys = sorted({k for _, v in views for k in (v.get("summary") or {})})
    rows = []
    for run_id, view in views:
        row = {"run_id": run_id, **{k: (view.get("summary") or {}).get(k) for k in keys}}
        rows.append(row)
    return {"metric_keys": keys, "rows": rows}
