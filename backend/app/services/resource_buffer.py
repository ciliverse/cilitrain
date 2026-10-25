"""In-process ring buffer of metrics-server samples for live resource charts.

Samples are also flushed to disk so a finished run still has a CPU/memory
curve after API restart or when the detail page was closed mid-job.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from pathlib import Path
from threading import Lock
from typing import Any

_lock = Lock()
_buffers: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=240))


def _live_path(run_id: str) -> Path:
    from app.config import settings

    d = settings.data_dir / "metrics" / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "resource_live.json"


def _hydrate(run_id: str) -> None:
    buf = _buffers.get(run_id)
    if buf:
        return
    path = _live_path(run_id)
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return
    samples = data.get("samples") if isinstance(data, dict) else None
    if not isinstance(samples, list) or not samples:
        return
    _buffers[run_id] = deque(samples, maxlen=240)


def _flush(run_id: str) -> None:
    with _lock:
        samples = list(_buffers.get(run_id, []))
    if not samples:
        return
    path = _live_path(run_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"samples": samples}), encoding="utf-8")
    tmp.replace(path)


def push_sample(run_id: str, *, cpu_cores: float | None, memory_mi: float | None) -> None:
    if cpu_cores is None and memory_mi is None:
        return
    sample = {
        "ts": time.time(),
        "cpu_cores": cpu_cores,
        "cpu_m": (cpu_cores * 1000) if cpu_cores is not None else None,
        "memory_mi": memory_mi,
    }
    with _lock:
        _hydrate(run_id)
        buf = _buffers[run_id]
        # Collapse double-fetches in the same second, not the UI's 3s poll.
        if buf and sample["ts"] - buf[-1]["ts"] < 1.5:
            buf[-1] = sample
        else:
            buf.append(sample)
    _flush(run_id)


def replace_series(run_id: str, samples: list[dict[str, Any]]) -> None:
    """Replace the live curve. Used by the public exhibit, which scripts samples."""
    trimmed = [s for s in samples if s.get("cpu_cores") is not None or s.get("memory_mi") is not None]
    with _lock:
        _buffers[run_id] = deque(trimmed[-240:], maxlen=240)
    _flush(run_id)


def series_for(run_id: str) -> list[dict[str, Any]]:
    with _lock:
        _hydrate(run_id)
        samples = list(_buffers.get(run_id, []))
    if not samples:
        return []
    t0 = samples[0]["ts"]
    out = []
    for s in samples:
        pt: dict[str, Any] = {
            "t": round(s["ts"] - t0, 1),
            "ts": s["ts"],  # wall-clock unix seconds (for UI tooltip)
        }
        if s.get("cpu_m") is not None:
            pt["cpu_m"] = s["cpu_m"]
            pt["cpu_cores"] = s["cpu_cores"]
        if s.get("memory_mi") is not None:
            pt["memory_mi"] = s["memory_mi"]
        out.append(pt)
    return out
