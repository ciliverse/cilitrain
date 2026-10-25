from app.services.resource_buffer import _buffers, push_sample, series_for


def test_polls_every_3s_accumulate_a_line(tmp_path, monkeypatch):
    """UI polls ~3s; a 5s merge window would leave a single dot on the chart."""
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    t0 = 1_000_000.0
    clock = {"now": t0}

    monkeypatch.setattr("app.services.resource_buffer.time.time", lambda: clock["now"])
    run = "run-chart-dots"
    for i in range(5):
        clock["now"] = t0 + i * 3
        push_sample(run, cpu_cores=0.08, memory_mi=80)
    series = series_for(run)
    assert len(series) >= 4
    assert series[-1]["t"] >= 10


def test_samples_survive_api_restart(tmp_path, monkeypatch):
    """Pod CPU/mem must be on disk so a finished run still has a curve after reload."""
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr("app.services.resource_buffer.time.time", lambda: 1_700_000.0)
    run = "run-persist-pod"
    push_sample(run, cpu_cores=0.2, memory_mi=128)
    monkeypatch.setattr("app.services.resource_buffer.time.time", lambda: 1_700_004.0)
    push_sample(run, cpu_cores=0.4, memory_mi=160)
    live = tmp_path / "metrics" / run / "resource_live.json"
    assert live.exists()
    _buffers.pop(run, None)
    series = series_for(run)
    assert len(series) == 2
    assert series[0]["cpu_m"] == 200
    assert series[-1]["memory_mi"] == 160
