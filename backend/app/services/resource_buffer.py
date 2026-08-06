"""In-process ring buffer of metrics-server samples for live resource charts."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock
from typing import Any

_lock = Lock()
_buffers: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=240))


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
        buf = _buffers[run_id]
        # avoid duplicates within 5s
        if buf and sample["ts"] - buf[-1]["ts"] < 5:
            buf[-1] = sample
        else:
            buf.append(sample)


def series_for(run_id: str) -> list[dict[str, Any]]:
    with _lock:
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
