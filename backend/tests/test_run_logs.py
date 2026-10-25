from app.services.run_logs import merge_log_text, normalize_cr


def test_cr_progress_becomes_multiple_lines():
    raw = "downloading\r#####   10%\r########## 100%\ndone\n"
    out = normalize_cr(raw)
    assert "10%" in out
    assert "100%" in out
    assert "done" in out
    assert out.count("\n") >= 2


def test_merge_appends_new_tail():
    stored = "a\nb\nc\n"
    incoming = "b\nc\nd\n"
    assert merge_log_text(stored, incoming) == "a\nb\nc\nd\n"


def test_merge_keeps_history_when_kube_returns_shorter_tail():
    stored = "install\ntrain\nloss=1\n"
    incoming = "loss=1\n"
    assert merge_log_text(stored, incoming) == stored


def test_merge_ignores_timeout_placeholder():
    stored = "epoch 1\nepoch 2\n"
    incoming = "(logs timed out: timed out)"
    assert merge_log_text(stored, incoming) == stored
