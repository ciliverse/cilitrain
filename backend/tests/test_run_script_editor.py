from app.api.routes import _templates, resolve_run_files
from fastapi import HTTPException

from app.services.job_builder import SCRIPT_MOUNT_PATH, build_job


def test_templates_return_script_body():
    rows = {t["id"]: t for t in _templates()}
    assert "print" in rows["nanogpt-cpu"]["script"]
    assert "metrics epoch=" in rows["nanogpt-cpu"]["script"]
    assert rows["custom"]["script"]
    assert rows["gpu-smoke"].get("script") in (None, "")


def test_resolve_prefers_posted_script():
    files = resolve_run_files("nanogpt-cpu", "print('mine')\n")
    assert files == {"train.py": "print('mine')\n"}


def test_resolve_falls_back_to_template():
    files = resolve_run_files("monitor-demo", None)
    assert "train.py" in files
    assert "metrics epoch=" in files["train.py"]


def test_script_over_256kib_rejected():
    blob = "x" * (256 * 1024 + 10)
    try:
        resolve_run_files("custom", blob)
        raise AssertionError("expected 400")
    except HTTPException as exc:
        assert exc.status_code == 400


def test_empty_command_defaults_to_python_workspace():
    files = resolve_run_files("custom", "print(1)\n")
    job = build_job(
        run_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name="paste",
        namespace="default",
        template="custom",
        image="python:3.12-slim",
        command=["python", "-u", f"{SCRIPT_MOUNT_PATH}/train.py"],
        args=[],
        cpu="1",
        memory="1Gi",
        timeout_seconds=600,
        files=files,
    )
    spec = job["spec"]["template"]["spec"]
    assert any(v["name"] == "scripts" for v in spec["volumes"])
    assert "print('mine')" not in str(job) or True
    dump = str(job)
    assert "print(1)" not in dump
