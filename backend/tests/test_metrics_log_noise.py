from app.services.metrics import parse_log_metrics


def test_platform_prefixed_lines_are_not_metrics():
    logs = "\n".join(
        [
            "[cilitrain] installing torch (cpu)...",
            "[cilitrain] nanogpt params=810280 vocab=40 device=cpu",
            "metrics epoch=1 loss=2.9000 val_loss=2.8000",
        ]
    )
    series = parse_log_metrics(logs)
    assert series == [{"epoch": 1, "loss": 2.9, "val_loss": 2.8, "x": 1.0}]


def test_timestamped_platform_line_ignored():
    logs = "2026-09-02T20:20:34+08:00 [cilitrain] nanogpt params=810280 vocab=40"
    assert parse_log_metrics(logs) == []


def test_step_progress_builds_a_curve():
    logs = "\n".join(
        [
            "[cilitrain] installing numpy + torch (cpu)...",
            "[cilitrain] epoch 1/8 step 10/40 loss 2.9919",
            "[cilitrain] epoch 1/8 step 20/40 loss 2.7460",
            "[cilitrain] epoch 1/8 step 40/40 loss 2.4958",
            "metrics epoch=1 loss=2.8609 val_loss=2.4676",
        ]
    )
    series = parse_log_metrics(logs)
    assert [round(p["x"], 2) for p in series if "step" in p] == [0.25, 0.5, 1.0]
    assert series[-1]["val_loss"] == 2.4676
    assert len(series) >= 4


def test_dedupe_keeps_steps_not_one_dot_per_epoch():
    from app.services.metrics import _dedupe_series

    pts = parse_log_metrics(
        "[cilitrain] epoch 1/8 step 10/40 loss 3.0\n"
        "[cilitrain] epoch 1/8 step 20/40 loss 2.5\n"
    )
    out = _dedupe_series(pts)
    assert len(out) == 2


def test_pip_warning_line_ignored():
    logs = "\n".join(
        [
            "WARNING: Running pip as the 'root' user can result in broken permissions",
            "UserWarning: Failed to initialize NumPy: No module named 'numpy'",
            "metrics epoch=2 loss=1.5",
        ]
    )
    assert parse_log_metrics(logs) == [{"epoch": 2, "loss": 1.5, "x": 2.0}]
