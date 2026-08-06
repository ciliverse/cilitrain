"""CiliKube deep-link helpers (no proxy submit).

Paths align with CiliKube SPA routes (see cilikube/web/src/App.tsx).
"""

from __future__ import annotations

from typing import Any


def _norm_base(base_url: str | None) -> str | None:
    if not base_url:
        return None
    base = base_url.strip().rstrip("/")
    return base or None


def build_cilikube_links(
    base_url: str | None,
    *,
    namespace: str,
    job_name: str | None = None,
    pod_name: str | None = None,
    pvc_name: str | None = None,
) -> dict[str, Any]:
    """Build deep-link object for Run API / UI."""
    base = _norm_base(base_url)
    empty = {
        "configured": False,
        "console": None,
        "job": None,
        "pod": None,
        "events": None,
        "pvc": None,
    }
    if not base:
        return empty

    ns = namespace or "default"
    links: dict[str, Any] = {
        "configured": True,
        "console": f"{base}/overview",
        "job": f"{base}/jobs/{ns}/{job_name}" if job_name else None,
        "pod": f"{base}/pods/{ns}/{pod_name}" if pod_name else None,
        "events": f"{base}/events",
        "pvc": f"{base}/persistentvolumeclaims/{ns}/{pvc_name}" if pvc_name else None,
    }
    return links


def primary_cilikube_url(links: dict[str, Any]) -> str | None:
    """Compat: prefer Job detail, else console."""
    if not links.get("configured"):
        return None
    return links.get("job") or links.get("console")


def job_deep_link(base_url: str | None, namespace: str, job_name: str) -> str | None:
    """Backward-compatible helper — Job detail only."""
    if not job_name:
        return None
    links = build_cilikube_links(base_url, namespace=namespace, job_name=job_name)
    return links.get("job")
