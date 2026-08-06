"""Lightweight cluster GPU capability probe (nvidia.com/gpu allocatable)."""

from __future__ import annotations

from typing import Any, Protocol

from fastapi import HTTPException

GPU_RESOURCE = "nvidia.com/gpu"


class SupportsListNodeAllocatable(Protocol):
    def list_node_allocatable(self) -> list[dict[str, Any]]: ...


def cluster_has_allocatable_gpu(nodes: list[dict[str, Any]]) -> bool:
    """True if any node reports allocatable nvidia.com/gpu > 0."""
    for node in nodes:
        status = node.get("status") or {}
        allocatable = status.get("allocatable") or {}
        raw = allocatable.get(GPU_RESOURCE)
        if raw is None:
            continue
        try:
            if int(str(raw).strip()) > 0:
                return True
        except ValueError:
            continue
    return False


def assert_cluster_has_gpu(kube: SupportsListNodeAllocatable, *, skip: bool = False) -> None:
    """Reject GPU submissions when the cluster has no allocatable GPUs.

    On list failure, reject by default (safer than silent Pending).
    Set skip=True only for operator debugging (CILITRAIN_GPU_PROBE_SKIP).
    """
    if skip:
        return
    try:
        nodes = kube.list_node_allocatable()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=f"GPU probe failed (cannot list nodes): {exc}",
        ) from exc
    if not cluster_has_allocatable_gpu(nodes):
        raise HTTPException(
            status_code=400,
            detail=(
                "cluster has no allocatable nvidia.com/gpu "
                "(need NVIDIA GPU nodes + device plugin; Kind/CPU clusters cannot run GPU jobs)"
            ),
        )
