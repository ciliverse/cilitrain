"""CiliKube deep-link helpers (no proxy submit in v0.1)."""

from __future__ import annotations


def job_deep_link(base_url: str | None, namespace: str, job_name: str) -> str | None:
    if not base_url:
        return None
    base = base_url.rstrip("/")
    # Best-effort console path; CiliKube may route workload detail similarly.
    return f"{base}/workloads/jobs/{namespace}/{job_name}"
