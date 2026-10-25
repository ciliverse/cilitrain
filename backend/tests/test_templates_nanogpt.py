from app.api.routes import _templates, template_files


def test_templates_include_nanogpt_cpu():
    rows = {t["id"]: t for t in _templates()}
    assert "nanogpt-cpu" in rows
    t = rows["nanogpt-cpu"]
    assert t["kind"] == "train"
    assert t.get("gpu_count", 0) == 0
    blob = " ".join((t.get("command") or []) + (t.get("args") or []))
    assert "torch" in blob
    assert "/workspace/train.py" in blob


def test_nanogpt_script_prints_epoch_metrics():
    script = template_files("nanogpt-cpu")["train.py"]
    assert "metrics epoch=" in script
    assert "metrics.json" in script
