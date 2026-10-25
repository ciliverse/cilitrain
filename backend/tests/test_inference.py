import base64
import json

import pytest
from fastapi import HTTPException

from app.services.inference import (
    CHUNK_BYTES,
    MODEL_MOUNT_PATH,
    READY_MARKER,
    deliver_files,
    infer_spec,
    parse_batch_csv,
    validate_infer_input,
    wait_for_model,
)
from app.services.job_builder import build_job

SPEC = {
    "fields": [
        {"key": "prompt", "type": "text", "default": "hi", "max_len": 10},
        {"key": "n", "type": "int", "min": 1, "max": 5, "default": 2},
        {"key": "t", "type": "float", "min": 0.1, "max": 2.0, "default": 0.8},
    ]
}


def test_build_job_model_mount_and_env():
    job = build_job(
        run_id="abc",
        name="x",
        namespace="default",
        template="sklearn-cpu",
        image="python:3.12-slim",
        command=["python", "infer.py"],
        args=[],
        cpu="500m",
        memory="1Gi",
        timeout_seconds=600,
        model_mount=True,
        extra_env={"CILITRAIN_INFER_INPUT": '{"a":1}'},
    )
    pod = job["spec"]["template"]["spec"]
    c = pod["containers"][0]
    assert {"name": "model", "mountPath": MODEL_MOUNT_PATH} in c["volumeMounts"]
    assert {"name": "model", "emptyDir": {}} in pod["volumes"]
    env = {e["name"]: e["value"] for e in c["env"]}
    assert env["CILITRAIN_MODEL_DIR"] == MODEL_MOUNT_PATH
    assert env["CILITRAIN_INFER_INPUT"] == '{"a":1}'


def test_build_job_without_model_has_no_model_volume():
    job = build_job(
        run_id="abc",
        name="x",
        namespace="default",
        template="custom",
        image="python:3.12-slim",
        command=["true"],
        args=[],
        cpu="500m",
        memory="1Gi",
        timeout_seconds=600,
    )
    names = [v["name"] for v in job["spec"]["template"]["spec"]["volumes"]]
    assert "model" not in names


def test_wait_for_model_wraps_command():
    cmd, args = wait_for_model(["bash", "-lc", "python -u /workspace/infer.py"], [])
    assert cmd == ["/bin/sh", "-c"]
    script = args[0]
    assert f"{MODEL_MOUNT_PATH}/{READY_MARKER}" in script
    assert "exit 70" in script
    assert "python -u /workspace/infer.py" in script


def test_validate_defaults_and_coercion():
    out = validate_infer_input(SPEC, {"n": "3"})
    assert out == {"prompt": "hi", "n": 3, "t": 0.8}


@pytest.mark.parametrize(
    "raw",
    [
        {"n": 9},
        {"t": 0},
        {"prompt": "x" * 11},
        {"nope": 1},
        {"n": "abc"},
        {"n": 1.5},
    ],
)
def test_validate_rejects(raw):
    with pytest.raises(HTTPException) as e:
        validate_infer_input(SPEC, raw)
    assert e.value.status_code == 400


def test_validate_rejects_oversized_input():
    spec = {"fields": [{"key": "prompt", "type": "text", "max_len": 100_000}]}
    with pytest.raises(HTTPException):
        validate_infer_input(spec, {"prompt": "x" * 40_000})


def test_deliver_files_chunks_and_marker(tmp_path):
    big = tmp_path / "model.pt"
    big.write_bytes(b"a" * (CHUNK_BYTES * 2 + 10))
    small = tmp_path / "meta.json"
    small.write_text(json.dumps({"k": 1}))
    calls: list[tuple[str, bytes]] = []

    def sink(script: str, data: bytes) -> None:
        calls.append((script, data))

    deliver_files(sink, [("model.pt", big), ("meta.json", small)])
    model_chunks = [d for s, d in calls if "model.pt" in s]
    assert len(model_chunks) == 3
    assert all(len(base64.b64decode(d)) <= CHUNK_BYTES for d in model_chunks)
    assert b"".join(base64.b64decode(d) for d in model_chunks) == big.read_bytes()
    assert READY_MARKER in calls[-1][0]


def test_parse_batch_csv_quoting_defaults_and_extras():
    text = '\ufeffref,prompt,n\nr1,"a, b",3\nr2,"line\nbreak",\n'
    rows = parse_batch_csv({**SPEC, "batch_max_rows": 5}, text)
    assert rows == [
        {"input": {"prompt": "a, b", "n": 3, "t": 0.8}, "extra": {"ref": "r1"}},
        {"input": {"prompt": "line\nbreak", "n": 2, "t": 0.8}, "extra": {"ref": "r2"}},
    ]


@pytest.mark.parametrize(
    "text",
    ["", "prompt,prompt\nx,y\n", "prompt\n", "prompt\n" + "x\n" * 6, "prompt,n\nx,1,extra\n"],
)
def test_parse_batch_csv_rejects(text):
    with pytest.raises(HTTPException):
        parse_batch_csv({**SPEC, "batch_max_rows": 5}, text)


def test_infer_spec_for_templates():
    assert infer_spec("nanogpt-cpu")["output"] == "text"
    assert infer_spec("sklearn-cpu")["output"] == "classification"
    assert infer_spec("custom") is None
