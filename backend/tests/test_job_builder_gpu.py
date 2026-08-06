import pytest
from fastapi import HTTPException

from app.services.job_builder import Guardrails, build_job


def test_gpu_zero_omits_nvidia_resource():
    job = build_job(
        run_id="00000000-0000-0000-0000-000000000001",
        name="t",
        namespace="default",
        template="x",
        image="busybox",
        command=["sh"],
        args=["-c", "echo"],
        cpu="100m",
        memory="128Mi",
        timeout_seconds=60,
        gpu_count=0,
    )
    res = job["spec"]["template"]["spec"]["containers"][0]["resources"]
    assert "nvidia.com/gpu" not in res["limits"]
    assert "nvidia.com/gpu" not in res["requests"]
    assert job["metadata"]["annotations"]["cilitrain.io/gpu-count"] == "0"


def test_gpu_one_sets_nvidia_resource_and_annotation():
    job = build_job(
        run_id="00000000-0000-0000-0000-000000000002",
        name="t",
        namespace="default",
        template="x",
        image="busybox",
        command=["sh"],
        args=["-c", "echo"],
        cpu="100m",
        memory="128Mi",
        timeout_seconds=60,
        gpu_count=1,
    )
    res = job["spec"]["template"]["spec"]["containers"][0]["resources"]
    assert res["limits"]["nvidia.com/gpu"] == "1"
    assert res["requests"]["nvidia.com/gpu"] == "1"
    assert job["metadata"]["annotations"]["cilitrain.io/gpu-count"] == "1"


def test_gpu_exceeds_guardrail():
    with pytest.raises(HTTPException) as ei:
        build_job(
            run_id="00000000-0000-0000-0000-000000000003",
            name="t",
            namespace="default",
            template="x",
            image="busybox",
            command=["sh"],
            args=["-c", "echo"],
            cpu="100m",
            memory="128Mi",
            timeout_seconds=60,
            gpu_count=3,
            guardrails=Guardrails(max_gpu=2),
        )
    assert ei.value.status_code == 400
    assert "GPU" in str(ei.value.detail)


def test_gpu_negative_rejected():
    with pytest.raises(HTTPException) as ei:
        build_job(
            run_id="00000000-0000-0000-0000-000000000004",
            name="t",
            namespace="default",
            template="x",
            image="busybox",
            command=["sh"],
            args=["-c", "echo"],
            cpu="100m",
            memory="128Mi",
            timeout_seconds=60,
            gpu_count=-1,
        )
    assert ei.value.status_code == 400
