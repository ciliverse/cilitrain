import yaml

from app.api.routes import _templates, template_files
from app.services.job_builder import build_job, build_script_configmap, job_name_for

RUN = "11111111-2222-3333-4444-555555555555"


def _job(**kw):
    return build_job(
        run_id=RUN,
        name="demo",
        namespace="default",
        template="nanogpt-cpu",
        image="python:3.12-slim",
        command=["bash", "-lc"],
        args=["python -u /workspace/train.py"],
        cpu="1",
        memory="1Gi",
        timeout_seconds=600,
        **kw,
    )


def test_files_mount_as_configmap_volume():
    job = _job(files={"train.py": "print('hi')\n"})
    spec = job["spec"]["template"]["spec"]
    vol = next(v for v in spec["volumes"] if v["name"] == "scripts")
    assert vol["configMap"]["name"] == f"{job_name_for(RUN)}-scripts"
    mount = next(
        m for m in spec["containers"][0]["volumeMounts"] if m["name"] == "scripts"
    )
    assert mount["mountPath"] == "/workspace"
    assert mount["readOnly"] is True


def test_no_files_means_no_scripts_volume():
    spec = _job()["spec"]["template"]["spec"]
    assert all(v["name"] != "scripts" for v in spec["volumes"])


def test_script_configmap_manifest():
    cm = build_script_configmap(
        run_id=RUN,
        namespace="default",
        template="nanogpt-cpu",
        files={"train.py": "print('hi')\n"},
    )
    assert cm["kind"] == "ConfigMap"
    assert cm["metadata"]["name"] == f"{job_name_for(RUN)}-scripts"
    assert cm["metadata"]["namespace"] == "default"
    assert cm["data"]["train.py"] == "print('hi')\n"
    assert cm["metadata"]["labels"]["cilitrain.io/run"] == RUN


def test_script_templates_stay_readable():
    rows = {t["id"]: t for t in _templates()}
    for tid in ("nanogpt-cpu", "sklearn-cpu", "monitor-demo"):
        t = rows[tid]
        blob = " ".join((t.get("command") or []) + (t.get("args") or []))
        assert "/workspace/train.py" in blob, tid
        # The whole point: no inlined program body in the manifest.
        assert "<<'PY'" not in blob, tid
        assert len(blob) < 400, (tid, len(blob))
        files = template_files(tid)
        assert "train.py" in files
        assert len(files["train.py"]) > 200


def test_rendered_job_yaml_is_short():
    files = template_files("nanogpt-cpu")
    job = _job(files=files)
    text = yaml.safe_dump(job, sort_keys=False)
    assert len(text.splitlines()) < 80
    assert "torch.nn" not in text
