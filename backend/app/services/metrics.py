"""Training metrics: metrics.json + log parsing (MLflow-style key=value lines)."""

from __future__ import annotations

import json
import re
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
        content = re.sub(r"^\S+\s+", "", line) if re.match(r"^\d{4}-", line) else line
        m = LINE_RE.search(content)
        if not m:
            # bare score lines only if we have no epoch series yet — handled later
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


def _dedupe_series(series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prefer one point per epoch; drop duplicate history+log merges."""
    if not series:
        return []
    by_epoch: dict[int, dict[str, Any]] = {}
    no_epoch: list[dict[str, Any]] = []
    for pt in series:
        if "epoch" in pt and isinstance(pt["epoch"], (int, float)):
            ep = int(pt["epoch"])
            prev = by_epoch.get(ep, {})
            merged = {**prev, **pt, "epoch": ep}
            by_epoch[ep] = merged
        else:
            no_epoch.append(pt)
    if by_epoch:
        # ignore trailing bare score-only points when epoch series exists
        return [by_epoch[k] for k in sorted(by_epoch)]
    # collapse identical consecutive score-only rows
    out: list[dict[str, Any]] = []
    for pt in no_epoch:
        if out and out[-1] == pt:
            continue
        out.append(pt)
    return out


def load_metrics_json(run_id: str) -> dict[str, Any] | None:
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
    if not final:
        for art in list_local_artifacts(run_id):
            if art["path"].endswith("metrics.json"):
                try:
                    final = json.loads(
                        read_local_artifact(run_id, art["path"]).read_text(encoding="utf-8")
                    )
                except Exception:  # noqa: BLE001
                    pass

    log_series = parse_log_metrics(logs)
    hist = final.get("history") if isinstance(final, dict) else None

    # Prefer structured history from metrics.json; fall back to logs (avoid concatenating both).
    if isinstance(hist, list) and hist:
        series = _dedupe_series([p for p in hist if isinstance(p, dict)])
    else:
        series = _dedupe_series(log_series)

    summary: dict[str, Any] = {}
    if isinstance(final, dict):
        for k, v in final.items():
            if isinstance(v, (int, float)) and k != "history":
                summary[k] = int(v) if k in {"epochs", "epoch", "rows"} and float(v).is_integer() else v
    if series:
        last = series[-1]
        for k, v in last.items():
            if k != "epoch" and isinstance(v, (int, float)) and k not in summary:
                summary[k] = v

    # Chart keys: prefer loss/acc; hide redundant score when acc exists
    raw_keys = sorted(
        {k for pt in series for k in pt.keys() if k != "epoch" and isinstance(pt.get(k), (int, float))}
    )
    if "acc" in raw_keys and "score" in raw_keys:
        raw_keys = [k for k in raw_keys if k != "score"]
    # stable preferred order
    preferred = ["loss", "acc", "accuracy", "score"]
    chart_keys = [k for k in preferred if k in raw_keys] + [k for k in raw_keys if k not in preferred]

    return {
        "summary": summary,
        "series": series,
        "chart_keys": chart_keys,
        "x_key": "epoch" if any("epoch" in p for p in series) else "index",
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
