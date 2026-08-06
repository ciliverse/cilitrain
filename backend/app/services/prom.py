"""Query Prometheus for pod CPU/memory time series."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx

from app.config import settings


def prometheus_base() -> str | None:
    base = (settings.prometheus_url or "").rstrip("/")
    return base or None


def _resource_freeze_path(run_id: str) -> Path:
    d = settings.data_dir / "metrics" / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "resource_series.json"


def load_frozen_resource(run_id: str) -> dict[str, Any] | None:
    path = _resource_freeze_path(run_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict) or not data.get("series"):
        return None
    return data


def save_frozen_resource(
    run_id: str, *, series: list[dict[str, Any]], source: str, pod_name: str | None = None
) -> None:
    if not series:
        return
    payload = {
        "series": series,
        "series_source": source,
        "pod_name": pod_name,
        "frozen_at": time.time(),
    }
    path = _resource_freeze_path(run_id)
    path.write_text(json.dumps(payload), encoding="utf-8")


def query_range(query: str, start: float, end: float, step: str = "15s") -> list[dict[str, Any]]:
    base = prometheus_base()
    if not base:
        return []
    if end <= start:
        return []
    url = f"{base}/api/v1/query_range"
    try:
        with httpx.Client(timeout=5.0) as client:
            r = client.get(
                url,
                params={"query": query, "start": start, "end": end, "step": step},
            )
            r.raise_for_status()
            data = r.json()
    except Exception:  # noqa: BLE001
        return []
    if data.get("status") != "success":
        return []
    result = (data.get("data") or {}).get("result") or []
    if not result:
        return []
    values = result[0].get("values") or []
    out: list[dict[str, Any]] = []
    for ts, val in values:
        try:
            out.append({"t": float(ts), "v": float(val)})
        except (TypeError, ValueError):
            continue
    return out


def pod_resource_series(
    namespace: str,
    pod_name: str,
    *,
    start_ts: float | None = None,
    end_ts: float | None = None,
    t0: float | None = None,
) -> dict[str, Any]:
    """Return CPU (cores) and memory (MiB) series for a pod from Prometheus.

    When start/end are provided (finished runs), the query window is pinned so
    charts stop drifting as wall-clock time advances.
    """
    now = time.time()
    if end_ts is not None:
        end = min(end_ts, now)
    else:
        end = now
    if start_ts is not None:
        start = start_ts
    else:
        start = end - 30 * 60
    # pad a bit for scrape lag / rate window
    start = start - 30
    if end_ts is None:
        pass
    else:
        end = end + 90

    cpu_q = (
        f'sum(rate(container_cpu_usage_seconds_total{{namespace="{namespace}",pod="{pod_name}",'
        f'container!="",container!="POD"}}[1m]))'
    )
    mem_q = (
        f'sum(container_memory_working_set_bytes{{namespace="{namespace}",pod="{pod_name}",'
        f'container!="",container!="POD"}})/1024/1024'
    )
    cpu = query_range(cpu_q, start, end)
    mem = query_range(mem_q, start, end)

    by_ts: dict[float, dict[str, Any]] = {}
    for p in cpu:
        by_ts.setdefault(p["t"], {"ts": p["t"]})["cpu_cores"] = p["v"]
    for p in mem:
        by_ts.setdefault(p["t"], {"ts": p["t"]})["memory_mi"] = p["v"]
    if not by_ts:
        return {"source": None, "series": [], "prometheus_url": prometheus_base()}

    # Fixed origin so relative X axis does not shift across polls
    origin = t0 if t0 is not None else min(by_ts)
    # Drop trailing points after the pod is gone: rate() can leave sparse zeros
    cutoff = end_ts + 60 if end_ts is not None else None
    merged: list[dict[str, Any]] = []
    for ts in sorted(by_ts):
        if cutoff is not None and ts > cutoff:
            continue
        row = by_ts[ts]
        pt: dict[str, Any] = {
            "t": round(max(0.0, ts - origin), 1),
            "ts": ts,  # wall-clock unix seconds (for UI tooltip)
        }
        if "cpu_cores" in row:
            pt["cpu_cores"] = row["cpu_cores"]
            pt["cpu_m"] = row["cpu_cores"] * 1000
        if "memory_mi" in row:
            pt["memory_mi"] = row["memory_mi"]
        merged.append(pt)

    return {
        "source": "prometheus",
        "series": merged,
        "prometheus_url": prometheus_base(),
    }


def prometheus_ready() -> bool:
    base = prometheus_base()
    if not base:
        return False
    try:
        with httpx.Client(timeout=2.0) as client:
            r = client.get(f"{base}/-/ready")
            return r.status_code < 400
    except Exception:  # noqa: BLE001
        return False
