"""Build batch/v1 Job manifests for CiliTrain runs."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

LABEL_MANAGED = "cilitrain.io/managed-by"
LABEL_RUN = "cilitrain.io/run"
LABEL_TEMPLATE = "cilitrain.io/template"
ANN_TIMEOUT = "cilitrain.io/timeout-seconds"


@dataclass
class Guardrails:
    max_cpu: float = 2.0
    max_memory_gi: float = 4.0
    default_timeout_seconds: int = 7200


def parse_cpu_cores(cpu: str) -> float:
    s = cpu.strip().lower()
    if s.endswith("m"):
        return float(s[:-1]) / 1000.0
    return float(s)


def parse_memory_gi(memory: str) -> float:
    s = memory.strip()
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*([KMGTPEi]*)", s, re.IGNORECASE)
    if not m:
        raise HTTPException(status_code=400, detail=f"invalid memory: {memory}")
    value = float(m.group(1))
    unit = (m.group(2) or "Gi").lower()
    # normalize to Gi
    if unit in ("", "gi", "g"):
        return value
    if unit in ("mi", "m"):
        return value / 1024.0
    if unit in ("ti", "t"):
        return value * 1024.0
    if unit == "ki":
        return value / (1024.0**2)
    raise HTTPException(status_code=400, detail=f"unsupported memory unit: {memory}")


def validate_resources(cpu: str, memory: str, timeout_seconds: int, guardrails: Guardrails) -> None:
    if parse_cpu_cores(cpu) > guardrails.max_cpu + 1e-9:
        raise HTTPException(
            status_code=400,
            detail=f"CPU exceeds guardrail ({guardrails.max_cpu} cores)",
        )
    if parse_memory_gi(memory) > guardrails.max_memory_gi + 1e-9:
        raise HTTPException(
            status_code=400,
            detail=f"memory exceeds guardrail ({guardrails.max_memory_gi} Gi)",
        )
    if timeout_seconds <= 0 or timeout_seconds > guardrails.default_timeout_seconds:
        # allow up to default max (2h); reject above
        if timeout_seconds > guardrails.default_timeout_seconds:
            raise HTTPException(
                status_code=400,
                detail=f"timeout exceeds guardrail ({guardrails.default_timeout_seconds}s)",
            )
        if timeout_seconds <= 0:
            raise HTTPException(status_code=400, detail="timeout_seconds must be positive")


def job_name_for(run_id: str) -> str:
    short = run_id.replace("-", "")[:10]
    return f"cilitrain-{short}"


def build_job(
    *,
    run_id: str,
    name: str,
    namespace: str,
    template: str,
    image: str,
    command: list[str],
    args: list[str],
    cpu: str,
    memory: str,
    timeout_seconds: int,
    pvc_name: str | None = None,
    pvc_mount_path: str = "/data",
    output_path: str = "/output",
    guardrails: Guardrails | None = None,
) -> dict[str, Any]:
    g = guardrails or Guardrails()
    validate_resources(cpu, memory, timeout_seconds, g)

    jn = job_name_for(run_id)
    labels = {
        LABEL_MANAGED: "cilitrain",
        LABEL_RUN: run_id,
        LABEL_TEMPLATE: template,
        "app.kubernetes.io/name": "cilitrain",
        "app.kubernetes.io/instance": jn,
    }

    volume_mounts: list[dict[str, Any]] = []
    volumes: list[dict[str, Any]] = []
    if pvc_name:
        volumes.append(
            {
                "name": "data",
                "persistentVolumeClaim": {"claimName": pvc_name},
            }
        )
        volume_mounts.append({"name": "data", "mountPath": pvc_mount_path})
        # also expose output under same PVC if output is under mount, else emptyDir
        if output_path.startswith(pvc_mount_path.rstrip("/") + "/") or output_path == pvc_mount_path:
            pass
        else:
            volumes.append({"name": "output", "emptyDir": {}})
            volume_mounts.append({"name": "output", "mountPath": output_path})
    else:
        volumes.append({"name": "output", "emptyDir": {}})
        volume_mounts.append({"name": "output", "mountPath": output_path})

    container: dict[str, Any] = {
        "name": "trainer",
        "image": image,
        "imagePullPolicy": "IfNotPresent",
        "resources": {
            "requests": {"cpu": cpu, "memory": memory},
            "limits": {"cpu": cpu, "memory": memory},
        },
        "env": [
            {"name": "CILITRAIN_RUN_ID", "value": run_id},
            {"name": "CILITRAIN_OUTPUT", "value": output_path},
            {"name": "PYTHONUNBUFFERED", "value": "1"},
        ],
        "volumeMounts": volume_mounts,
    }
    if command:
        container["command"] = command
    if args:
        container["args"] = args

    job: dict[str, Any] = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": jn,
            "namespace": namespace,
            "labels": labels,
            "annotations": {
                ANN_TIMEOUT: str(timeout_seconds),
                "cilitrain.io/display-name": name,
            },
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": timeout_seconds,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [container],
                    "volumes": volumes,
                },
            },
        },
    }
    return job


def dumps_command(command: list[str]) -> str:
    return json.dumps(command)


def loads_command(raw: str) -> list[str]:
    data = json.loads(raw or "[]")
    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="command must be a JSON list")
    return [str(x) for x in data]
