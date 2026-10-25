from app.services.artifacts import (
    HARVEST_DONE,
    artifacts_dir,
    list_local_artifacts,
    set_harvest_status,
)


def test_internal_state_files_are_not_artifacts(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    run_id = "run-internal-1"
    set_harvest_status(run_id, HARVEST_DONE, files=0)
    (artifacts_dir(run_id) / "metrics.json").write_text("{}", encoding="utf-8")

    paths = {item["path"] for item in list_local_artifacts(run_id)}
    assert paths == {"metrics.json"}
