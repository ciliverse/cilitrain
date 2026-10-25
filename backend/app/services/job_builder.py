"""Build batch/v1 Job manifests for CiliTrain runs."""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

LABEL_MANAGED = "cilitrain.io/managed-by"
LABEL_RUN = "cilitrain.io/run"
LABEL_TEMPLATE = "cilitrain.io/template"
ANN_TIMEOUT = "cilitrain.io/timeout-seconds"
ANN_HOLD = "cilitrain.io/hold-seconds"
ANN_GPU = "cilitrain.io/gpu-count"
GPU_RESOURCE = "nvidia.com/gpu"

HOLD_SECONDS_MIN = 15
HOLD_SECONDS_MAX = 300
HOLD_SECONDS_DEFAULT = 45


def clamp_hold_seconds(value: int | None) -> int:
    n = HOLD_SECONDS_DEFAULT if value is None else int(value)
    return max(HOLD_SECONDS_MIN, min(HOLD_SECONDS_MAX, n))


def wrap_with_hold(command: list[str], args: list[str], hold_seconds: int) -> tuple[list[str], list[str]]:
    """Wrap user argv: run command, touch .cilitrain-done, sleep hold, exit with original code."""
    hold = clamp_hold_seconds(hold_seconds)
    user_argv = [str(x) for x in (command or [])] + [str(x) for x in (args or [])]
    if not user_argv:
        user_argv = ["true"]
    joined = shlex.join(user_argv)
    # set -e: failure jumps to || ec=$?; hold always runs; original exit code preserved.
    script = (
        "set -eu; ec=0; "
        f"{joined} || ec=$?; "
        'out="${CILITRAIN_OUTPUT:-/output}"; '
        'mkdir -p "$out" 2>/dev/null || true; '
        'touch "$out/.cilitrain-done" 2>/dev/null || true; '
        f'sleep "${{CILITRAIN_HOLD_SECONDS:-{hold}}}"; '
        'exit "$ec"'
    )
    return ["/bin/sh", "-c"], [script]


@dataclass
class Guardrails:
    max_cpu: float = 8.0
    max_memory_gi: float = 16.0
    max_gpu: int = 2
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


def validate_resources(
    cpu: str,
    memory: str,
    timeout_seconds: int,
    guardrails: Guardrails,
    *,
    gpu_count: int = 0,
) -> None:
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
    if gpu_count < 0:
        raise HTTPException(status_code=400, detail="gpu_count must be >= 0")
    if gpu_count > guardrails.max_gpu:
        raise HTTPException(
            status_code=400,
            detail=f"GPU count exceeds guardrail (max_gpu={guardrails.max_gpu})",
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


SCRIPT_MOUNT_PATH = "/workspace"
MODEL_MOUNT_PATH = "/model"


def script_configmap_name(run_id: str) -> str:
    return f"{job_name_for(run_id)}-scripts"


def build_script_configmap(
    *,
    run_id: str,
    namespace: str,
    template: str,
    files: dict[str, str],
) -> dict[str, Any]:
    """Program bodies live in a ConfigMap so the Job manifest stays reviewable."""
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": script_configmap_name(run_id),
            "namespace": namespace,
            "labels": {
                LABEL_MANAGED: "cilitrain",
                LABEL_RUN: run_id,
                LABEL_TEMPLATE: template,
            },
        },
        "data": dict(files),
    }


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
    gpu_count: int = 0,
    pvc_name: str | None = None,
    pvc_mount_path: str = "/data",
    output_path: str = "/output",
    hold_seconds: int | None = None,
    guardrails: Guardrails | None = None,
    files: dict[str, str] | None = None,
    model_mount: bool = False,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    g = guardrails or Guardrails()
    validate_resources(cpu, memory, timeout_seconds, g, gpu_count=gpu_count)
    hold = clamp_hold_seconds(hold_seconds)
    gpus = int(gpu_count)

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

    if files:
        volumes.append(
            {"name": "scripts", "configMap": {"name": script_configmap_name(run_id)}}
        )
        volume_mounts.append(
            {"name": "scripts", "mountPath": SCRIPT_MOUNT_PATH, "readOnly": True}
        )

    if model_mount:
        volumes.append({"name": "model", "emptyDir": {}})
        volume_mounts.append({"name": "model", "mountPath": MODEL_MOUNT_PATH})

    wrap_cmd, wrap_args = wrap_with_hold(command, args, hold)

    requests: dict[str, str] = {"cpu": cpu, "memory": memory}
    limits: dict[str, str] = {"cpu": cpu, "memory": memory}
    if gpus > 0:
        requests[GPU_RESOURCE] = str(gpus)
        limits[GPU_RESOURCE] = str(gpus)

    container: dict[str, Any] = {
        "name": "trainer",
        "image": image,
        "imagePullPolicy": "IfNotPresent",
        "resources": {
            "requests": requests,
            "limits": limits,
        },
        "env": [
            {"name": "CILITRAIN_RUN_ID", "value": run_id},
            {"name": "CILITRAIN_OUTPUT", "value": output_path},
            {"name": "CILITRAIN_HOLD_SECONDS", "value": str(hold)},
            {"name": "CILITRAIN_GPU_COUNT", "value": str(gpus)},
            {"name": "PYTHONUNBUFFERED", "value": "1"},
            *([{"name": "CILITRAIN_DATA", "value": pvc_mount_path}] if pvc_name else []),
            *([{"name": "CILITRAIN_MODEL_DIR", "value": MODEL_MOUNT_PATH}] if model_mount else []),
            *[{"name": k, "value": v} for k, v in (extra_env or {}).items()],
        ],
        "volumeMounts": volume_mounts,
        "command": wrap_cmd,
        "args": wrap_args,
    }

    job: dict[str, Any] = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": jn,
            "namespace": namespace,
            "labels": labels,
            "annotations": {
                ANN_TIMEOUT: str(timeout_seconds),
                ANN_HOLD: str(hold),
                ANN_GPU: str(gpus),
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
