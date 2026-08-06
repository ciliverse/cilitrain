from app.services.artifacts import (
    HARVEST_DONE,
    HARVEST_PENDING,
    HARVEST_SKIPPED,
    get_harvest_status,
    harvest_is_done,
    set_harvest_status,
)
from app.services.job_builder import wrap_with_hold


def test_harvest_state_roundtrip(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    assert get_harvest_status("r1")["status"] == HARVEST_PENDING
    assert not harvest_is_done("r1")
    set_harvest_status("r1", HARVEST_DONE, files=2, marker=True)
    st = get_harvest_status("r1")
    assert st["status"] == HARVEST_DONE
    assert st["files"] == 2
    assert harvest_is_done("r1")
    set_harvest_status("r2", HARVEST_SKIPPED, files=0)
    assert get_harvest_status("r2")["status"] == HARVEST_SKIPPED


def test_wrap_preserves_failure_exit_path():
    _, args = wrap_with_hold(["false"], [], 45)
    script = args[0]
    assert "|| ec=$?" in script
    assert 'exit "$ec"' in script
