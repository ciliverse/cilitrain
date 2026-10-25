"""Accumulate pod logs on disk so the UI is not stuck with k8s' latest tail."""

from __future__ import annotations

import json
from pathlib import Path

_PLACEHOLDER_PREFIXES = (
    "(logs timed out",
    "(logs not ready",
    "(集群不可达",
    "(尚无 Pod",
    "(暂无日志输出",
)


def normalize_cr(text: str) -> str:
    """pip / tqdm redraw with CR; turn those updates into real lines."""
    if not text or "\r" not in text:
        return text
    parts: list[str] = []
    for row in text.split("\n"):
        if "\r" not in row:
            parts.append(row)
            continue
        segs = [s for s in row.split("\r") if s.strip()]
        if len(segs) > 40:
            step = max(1, len(segs) // 30)
            segs = segs[::step]
            if segs[-1] != row.split("\r")[-1].strip():
                last = row.split("\r")[-1].strip()
                if last:
                    segs.append(last)
        parts.extend(segs)
    return "\n".join(parts)


def merge_log_text(stored: str, incoming: str) -> str:
    stored = stored or ""
    incoming = normalize_cr(incoming or "")
    if not incoming.strip():
        return stored
    if incoming.startswith(_PLACEHOLDER_PREFIXES) and stored.strip():
        return stored
    if incoming.startswith(_PLACEHOLDER_PREFIXES) and not stored.strip():
        return incoming
    if not stored.strip():
        return incoming
    if incoming == stored:
        return stored
    if stored in incoming:
        return incoming
    if incoming in stored:
        return stored
    s_lines = stored.splitlines()
    i_lines = incoming.splitlines()
    max_n = min(len(s_lines), len(i_lines))
    for n in range(max_n, 0, -1):
        if s_lines[-n:] == i_lines[:n]:
            joined = s_lines + i_lines[n:]
            nl = "\n" if incoming.endswith("\n") or stored.endswith("\n") else ""
            return "\n".join(joined) + (nl if joined else "")
    return stored.rstrip("\n") + "\n" + incoming.lstrip("\n")


def _log_path(run_id: str) -> Path:
    from app.config import settings

    d = settings.data_dir / "metrics" / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "trainer.log"


def _meta_path(run_id: str) -> Path:
    from app.config import settings

    d = settings.data_dir / "metrics" / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "trainer.log.json"


def load_run_logs(run_id: str) -> tuple[str, str | None]:
    path = _log_path(run_id)
    text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    pod = None
    meta = _meta_path(run_id)
    if meta.exists():
        try:
            pod = json.loads(meta.read_text(encoding="utf-8")).get("pod_name")
        except Exception:  # noqa: BLE001
            pod = None
    return text, pod


def save_run_logs(run_id: str, text: str, pod_name: str | None = None) -> None:
    if not text:
        return
    path = _log_path(run_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    if pod_name:
        _meta_path(run_id).write_text(
            json.dumps({"pod_name": pod_name}), encoding="utf-8"
        )


def absorb_logs(run_id: str, incoming: str, pod_name: str | None = None) -> str:
    stored, _ = load_run_logs(run_id)
    merged = merge_log_text(stored, incoming)
    if merged.startswith(_PLACEHOLDER_PREFIXES) and not stored.strip():
        return merged
    save_run_logs(run_id, merged, pod_name)
    return merged
