"""Collect /output artifacts from training pods into local store."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import Any

from kubernetes.stream import stream

from app.config import settings
from app.services.cluster.direct import DirectKube


def artifacts_dir(run_id: str) -> Path:
    path = settings.data_dir / "artifacts" / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def metrics_path(run_id: str) -> Path:
    path = settings.data_dir / "metrics"
    path.mkdir(parents=True, exist_ok=True)
    return path / f"{run_id}.json"


def _exec(kube: DirectKube, pod_name: str, namespace: str, script: str) -> str:
    try:
        resp = stream(
            kube.core.connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            command=["/bin/sh", "-c", script],
            container="trainer",
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
        )
    except Exception:  # noqa: BLE001
        return ""
    if resp is None:
        return ""
    if isinstance(resp, (bytes, bytearray)):
        return resp.decode("utf-8", errors="replace")
    return str(resp)


def list_remote_files(kube: DirectKube, pod_name: str, namespace: str, output_path: str = "/output") -> list[str]:
    out = _exec(
        kube,
        pod_name,
        namespace,
        f"find {output_path} -type f 2>/dev/null | head -80",
    )
    files = [line.strip() for line in out.splitlines() if line.strip()]
    return files


def collect_from_pod(
    kube: DirectKube,
    *,
    run_id: str,
    namespace: str,
    pod_name: str,
    output_path: str = "/output",
) -> list[dict[str, Any]]:
    """Copy small files from pod /output into local artifact store."""
    dest = artifacts_dir(run_id)
    remote_files = list_remote_files(kube, pod_name, namespace, output_path)
    collected: list[dict[str, Any]] = []
    for remote in remote_files:
        # relative name under output
        rel = remote
        if remote.startswith(output_path.rstrip("/") + "/"):
            rel = remote[len(output_path.rstrip("/")) + 1 :]
        elif remote.startswith(output_path):
            rel = remote[len(output_path) :].lstrip("/")
        if not rel or ".." in rel:
            continue
        b64 = _exec(
            kube,
            pod_name,
            namespace,
            f"base64 '{remote}' 2>/dev/null | head -c 4000000",
        ).strip()
        if not b64:
            continue
        try:
            # strip whitespace/newlines from base64
            raw = base64.b64decode(re.sub(r"\s+", "", b64), validate=False)
        except Exception:  # noqa: BLE001
            continue
        if len(raw) > 2_000_000:
            continue
        local = dest / rel
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(raw)
        collected.append({"path": rel, "size": len(raw)})
    # Merge with previous index — never clobber successful harvest with empty reads.
    prev = list_local_artifacts(run_id)
    by_path = {item["path"]: item for item in prev}
    for item in collected:
        by_path[item["path"]] = item
    merged = list(by_path.values())
    if merged:
        (dest / ".index.json").write_text(json.dumps(merged, indent=2), encoding="utf-8")
    return merged


def list_local_artifacts(run_id: str) -> list[dict[str, Any]]:
    dest = artifacts_dir(run_id)
    index = dest / ".index.json"
    if index.exists():
        try:
            return json.loads(index.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    items: list[dict[str, Any]] = []
    for p in dest.rglob("*"):
        if p.is_file() and p.name != ".index.json":
            items.append({"path": str(p.relative_to(dest)), "size": p.stat().st_size})
    return items


def read_local_artifact(run_id: str, rel_path: str) -> Path:
    dest = artifacts_dir(run_id).resolve()
    target = (dest / rel_path).resolve()
    if not str(target).startswith(str(dest)) or not target.is_file():
        raise FileNotFoundError(rel_path)
    return target
