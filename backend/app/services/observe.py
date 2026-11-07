"""Cluster observability: node CPU/GPU plus training and inference metrics."""

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from app.models.entities import Cluster, InferenceService, Run, User
from app.services.access import can_access_run, has_grant, is_admin
from app.services.metrics import trend_from_view, build_metrics_view
from app.services.prom import gpu_util_samples, prometheus_ready
from app.services.run_logs import load_run_logs

_ACTIVE = {"queued", "pending", "running"}
_TERMINAL = {"succeeded", "failed", "timeout", "cancelled"}


def cpu_cores(raw: str | None) -> float | None:
    if not raw:
        return None
    text = str(raw).strip()
    try:
        if text.endswith("n"):
            return int(float(text[:-1])) / 1_000_000_000
        if text.endswith("u"):
            return int(float(text[:-1])) / 1_000_000
        if text.endswith("m"):
            return int(float(text[:-1])) / 1000
        return float(text)
    except ValueError:
        return None


def memory_mi(raw: str | None) -> float | None:
    if not raw:
        return None
    text = str(raw).strip()
    try:
        if text.endswith("Ki"):
            return float(text[:-2]) / 1024
        if text.endswith("Mi"):
            return float(text[:-2])
        if text.endswith("Gi"):
            return float(text[:-2]) * 1024
        if text.endswith("Ti"):
            return float(text[:-2]) * 1024 * 1024
        return int(float(text)) / (1024 * 1024)
    except ValueError:
        return None


def _round(value: float | None, digits: int = 2) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def _can_see_service(session: Session, user: User, svc: InferenceService) -> bool:
    if is_admin(user) or svc.owner_user_id == user.id:
        return True
    if not svc.cluster_id:
        return False
    return has_grant(session, user.id, svc.cluster_id, svc.namespace)


def _training_rows(session: Session, user: User, cluster_id: str, pod_usage: dict[str, dict]) -> list[dict]:
    rows = session.exec(select(Run).where(Run.cluster_id == cluster_id)).all()
    visible = [r for r in rows if can_access_run(session, user, r) and (r.kind or "train") != "infer"]
    visible.sort(key=lambda r: r.created_at, reverse=True)
    active = [r for r in visible if r.status in _ACTIVE][:12]
    done = [r for r in visible if r.status in _TERMINAL][:8]
    picked = active + [r for r in done if r.id not in {a.id for a in active}]
    out = []
    for run in picked:
        logs, _ = load_run_logs(run.id)
        view = build_metrics_view(run.id, logs=logs or "")
        trend = trend_from_view(view) or {}
        usage = pod_usage.get(run.id) or {}
        summary = view.get("summary") or {}
        loss = summary.get("loss")
        if loss is None and trend.get("key") == "loss":
            loss = trend.get("last")
        out.append(
            {
                "id": run.id,
                "name": run.name,
                "status": run.status,
                "template": run.template,
                "gpu": int(run.gpu_count or 0),
                "cpu_cores": _round(usage.get("cpu_cores"), 3),
                "memory_mi": _round(usage.get("memory_mi"), 1),
                "metric_key": trend.get("key"),
                "metric_last": _round(float(trend["last"]), 4) if trend.get("last") is not None else (
                    _round(float(loss), 4) if isinstance(loss, (int, float)) else None
                ),
                "points": trend.get("points") or [],
            }
        )
    return out


def _inference_rows(session: Session, user: User, cluster_id: str, pod_usage: dict[str, dict]) -> list[dict]:
    rows = session.exec(select(InferenceService)).all()
    visible = [s for s in rows if _can_see_service(session, user, s)]
    visible.sort(key=lambda s: (s.cluster_id != cluster_id, s.created_at), reverse=False)
    out = []
    for svc in visible[:30]:
        usage = pod_usage.get(svc.id) or {}
        avg = round(svc.total_ms / svc.requests, 1) if svc.requests else None
        out.append(
            {
                "id": svc.id,
                "name": svc.name,
                "status": svc.status,
                "provider": svc.template == "provider" or not svc.cluster_id,
                "on_cluster": svc.cluster_id == cluster_id,
                "requests": int(svc.requests or 0),
                "errors": int(svc.errors or 0),
                "avg_latency_ms": avg,
                "replicas": int(svc.replicas or 0),
                "cpu_cores": _round(usage.get("cpu_cores"), 3),
                "memory_mi": _round(usage.get("memory_mi"), 1),
            }
        )
    out.sort(key=lambda row: (not row["on_cluster"], row["provider"], row["name"]))
    return out


def _index_pod_usage(rows: list[dict[str, Any]]) -> tuple[dict[str, dict], dict[str, dict]]:
    runs: dict[str, dict[str, float]] = {}
    services: dict[str, dict[str, float]] = {}

    def add(bucket: dict[str, dict[str, float]], key: str, cpu: float | None, mem: float | None) -> None:
        if not key:
            return
        slot = bucket.setdefault(key, {"cpu_cores": 0.0, "memory_mi": 0.0, "saw_cpu": 0.0, "saw_mem": 0.0})
        if cpu is not None:
            slot["cpu_cores"] += cpu
            slot["saw_cpu"] = 1
        if mem is not None:
            slot["memory_mi"] += mem
            slot["saw_mem"] = 1

    for row in rows:
        cpu = cpu_cores(row.get("cpu"))
        mem = memory_mi(row.get("memory"))
        add(runs, str(row.get("run_id") or ""), cpu, mem)
        add(services, str(row.get("service_id") or ""), cpu, mem)

    def clean(bucket: dict[str, dict[str, float]]) -> dict[str, dict]:
        out = {}
        for key, slot in bucket.items():
            out[key] = {
                "cpu_cores": slot["cpu_cores"] if slot["saw_cpu"] else None,
                "memory_mi": slot["memory_mi"] if slot["saw_mem"] else None,
            }
        return out

    return clean(runs), clean(services)


def observe_payload(
    *,
    cluster_id: str,
    cluster_name: str,
    clusters: list[dict[str, str]],
    nodes: list[dict[str, Any]],
    node_usage: list[dict[str, str]],
    pod_usage: list[dict[str, Any]],
    gpu_samples: list[dict[str, Any]],
    prometheus: bool,
    training: list[dict],
    inference: list[dict],
    cluster_error: str | None = None,
    simulated: bool = False,
) -> dict[str, Any]:
    usage_by_name = {row["name"]: row for row in node_usage if row.get("name")}
    gpu_by_node: dict[str, list[float]] = {}
    gpu_values: list[float] = []
    for sample in gpu_samples:
        value = float(sample.get("value") or 0)
        gpu_values.append(value)
        node = str(sample.get("node") or "")
        if node:
            gpu_by_node.setdefault(node, []).append(value)

    node_rows = []
    cpu_alloc = cpu_used = mem_alloc = mem_used = 0.0
    saw_cpu_used = saw_mem_used = False
    gpu_alloc = 0
    for node in nodes:
        name = str(node.get("name") or "")
        alloc_cpu = cpu_cores(str(node.get("cpu") or ""))
        alloc_mem = memory_mi(str(node.get("memory") or ""))
        live = usage_by_name.get(name) or {}
        used_cpu = cpu_cores(live.get("cpu"))
        used_mem = memory_mi(live.get("memory"))
        if alloc_cpu:
            cpu_alloc += alloc_cpu
        if alloc_mem:
            mem_alloc += alloc_mem
        if used_cpu is not None:
            cpu_used += used_cpu
            saw_cpu_used = True
        if used_mem is not None:
            mem_used += used_mem
            saw_mem_used = True
        node_gpu = int(node.get("gpu") or 0)
        gpu_alloc += node_gpu
        node_utils = gpu_by_node.get(name) or []
        node_rows.append(
            {
                "name": name,
                "ready": bool(node.get("ready")),
                "cpu_alloc": _round(alloc_cpu, 2),
                "cpu_used": _round(used_cpu, 2),
                "mem_alloc_mi": _round(alloc_mem, 0),
                "mem_used_mi": _round(used_mem, 0),
                "gpu_alloc": node_gpu,
                "gpu_util": _round(sum(node_utils) / len(node_utils), 1) if node_utils else None,
            }
        )

    return {
        "cluster_id": cluster_id,
        "cluster_name": cluster_name,
        "clusters": clusters,
        "cluster_error": cluster_error,
        "sources": {
            "metrics_server": (not simulated)
            and (bool(node_usage) or any(row.get("cpu") or row.get("memory") for row in pod_usage)),
            "prometheus": bool(prometheus) and not simulated,
            "gpu_util": bool(gpu_samples) and not simulated,
            "simulated": simulated,
        },
        "totals": {
            "cpu_alloc": _round(cpu_alloc, 2),
            "cpu_used": _round(cpu_used, 2) if saw_cpu_used else None,
            "mem_alloc_mi": _round(mem_alloc, 0),
            "mem_used_mi": _round(mem_used, 0) if saw_mem_used else None,
            "gpu_alloc": gpu_alloc,
            "gpu_util": _round(sum(gpu_values) / len(gpu_values), 1) if gpu_values else None,
            "gpu_count": len(gpu_values),
        },
        "nodes": node_rows,
        "training": training,
        "inference": inference,
    }


def collect_observe(session: Session, user: User, cluster: Cluster, kube: Any | None) -> dict[str, Any]:
    clusters = session.exec(select(Cluster).order_by(Cluster.created_at.desc())).all()
    from app.services.access import visible_cluster_ids

    allowed = visible_cluster_ids(session, user)
    cluster_rows = [
        {"id": c.id, "name": c.name}
        for c in clusters
        if allowed is None or c.id in allowed
    ]
    nodes: list[dict] = []
    node_usage: list[dict[str, str]] = []
    pod_usage: list[dict] = []
    gpu_samples: list[dict] = []
    prometheus = False
    error = None
    simulated = bool(getattr(cluster, "simulated", False))
    if simulated:
        from app.services.showcase import showcase_observe_parts

        parts = showcase_observe_parts()
        nodes = parts["nodes"]
        node_usage = parts["node_usage"]
        pod_usage = parts["pod_usage"]
        gpu_samples = parts["gpu_samples"]
    elif kube is not None:
        try:
            from app.services.cluster.direct import node_brief, _safe_items

            nodes = [node_brief(node) for node in _safe_items(kube._list_nodes)]
            node_usage = kube.list_node_usage()
            pod_usage = kube.list_platform_pod_usage()
            gpu_samples = gpu_util_samples()
            prometheus = prometheus_ready()
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
    run_usage, svc_usage = _index_pod_usage(pod_usage)
    return observe_payload(
        cluster_id=cluster.id,
        cluster_name=cluster.name,
        clusters=cluster_rows,
        nodes=nodes,
        node_usage=node_usage,
        pod_usage=pod_usage,
        gpu_samples=gpu_samples,
        prometheus=prometheus,
        training=_training_rows(session, user, cluster.id, run_usage),
        inference=_inference_rows(session, user, cluster.id, svc_usage),
        cluster_error=error,
        simulated=simulated,
    )
