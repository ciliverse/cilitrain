from app.services.observe import cpu_cores, memory_mi, observe_payload


def test_quantity_parsers():
    assert cpu_cores("500m") == 0.5
    assert cpu_cores("2") == 2
    assert memory_mi("512Mi") == 512
    assert memory_mi("2Gi") == 2048


def test_observe_payload_sums_nodes_and_marks_missing_gpu_util():
    payload = observe_payload(
        cluster_id="c1",
        cluster_name="lab",
        clusters=[{"id": "c1", "name": "lab"}],
        nodes=[
            {"name": "n1", "ready": True, "cpu": "4", "memory": "8Gi", "gpu": 0},
            {"name": "n2", "ready": True, "cpu": "4000m", "memory": "8192Mi", "gpu": 1},
        ],
        node_usage=[{"name": "n1", "cpu": "1000m", "memory": "1024Mi"}],
        pod_usage=[],
        gpu_samples=[],
        prometheus=False,
        training=[{"id": "r", "name": "job", "status": "running", "points": [1, 0.5]}],
        inference=[{"id": "s", "name": "svc", "requests": 3, "avg_latency_ms": 12}],
    )
    assert payload["totals"]["cpu_alloc"] == 8
    assert payload["totals"]["cpu_used"] == 1
    assert payload["totals"]["mem_alloc_mi"] == 16384
    assert payload["totals"]["gpu_alloc"] == 1
    assert payload["totals"]["gpu_util"] is None
    assert payload["sources"]["metrics_server"] is True
    assert payload["sources"]["gpu_util"] is False
    assert payload["nodes"][0]["cpu_used"] == 1
    assert payload["nodes"][1]["cpu_used"] is None
    assert payload["training"][0]["name"] == "job"
