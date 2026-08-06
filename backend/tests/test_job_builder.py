import pytest
from fastapi import HTTPException

from app.services.job_builder import (
    LABEL_MANAGED,
    LABEL_RUN,
    Guardrails,
    build_job,
    parse_cpu_cores,
    parse_memory_gi,
)


def test_parse_cpu():
    assert parse_cpu_cores("500m") == 0.5
    assert parse_cpu_cores("2") == 2.0


def test_parse_memory():
    assert parse_memory_gi("1Gi") == 1.0
    assert parse_memory_gi("512Mi") == 0.5


def test_guardrail_cpu():
    with pytest.raises(HTTPException) as ei:
        build_job(
            run_id="11111111-1111-1111-1111-111111111111",
            name="t",
            namespace="default",
            template="custom",
            image="python:3.12-slim",
            command=["python"],
            args=[],
            cpu="4",
            memory="1Gi",
            timeout_seconds=600,
            guardrails=Guardrails(),
        )
    assert ei.value.status_code == 400


def test_build_job_labels():
    run_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    job = build_job(
        run_id=run_id,
        name="demo",
        namespace="ml",
        template="sklearn-cpu",
        image="python:3.12-slim",
        command=["bash", "-lc"],
        args=["echo hi"],
        cpu="500m",
        memory="1Gi",
        timeout_seconds=1800,
        hold_seconds=45,
    )
    assert job["kind"] == "Job"
    assert job["metadata"]["labels"][LABEL_MANAGED] == "cilitrain"
    assert job["metadata"]["labels"][LABEL_RUN] == run_id
    assert job["spec"]["activeDeadlineSeconds"] == 1800
    assert job["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["cpu"] == "500m"


def test_build_job_hold_wrap():
    from app.services.job_builder import ANN_HOLD, wrap_with_hold

    cmd, args = wrap_with_hold(["python"], ["-c", "print('x y')"], 45)
    assert cmd == ["/bin/sh", "-c"]
    script = args[0]
    assert ".cilitrain-done" in script
    assert "sleep" in script
    # quoted arg preserved via shlex
    assert "x y" in script

    job = build_job(
        run_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name="demo",
        namespace="ml",
        template="custom",
        image="python:3.12-slim",
        command=["bash", "-lc"],
        args=["echo hi"],
        cpu="500m",
        memory="1Gi",
        timeout_seconds=1800,
        hold_seconds=60,
    )
    c = job["spec"]["template"]["spec"]["containers"][0]
    assert c["command"] == ["/bin/sh", "-c"]
    assert ".cilitrain-done" in c["args"][0]
    assert any(e["name"] == "CILITRAIN_HOLD_SECONDS" and e["value"] == "60" for e in c["env"])
    assert job["metadata"]["annotations"][ANN_HOLD] == "60"


def test_clamp_hold_seconds():
    from app.services.job_builder import clamp_hold_seconds

    assert clamp_hold_seconds(5) == 15
    assert clamp_hold_seconds(500) == 300
    assert clamp_hold_seconds(45) == 45
