import pytest
from fastapi import HTTPException

from app.services.gpu_probe import assert_cluster_has_gpu, cluster_has_allocatable_gpu


def test_detects_gpu_from_allocatable():
    nodes = [
        {"status": {"allocatable": {"cpu": "4", "nvidia.com/gpu": "2"}}},
    ]
    assert cluster_has_allocatable_gpu(nodes) is True


def test_no_gpu_nodes():
    nodes = [{"status": {"allocatable": {"cpu": "4", "memory": "8Gi"}}}]
    assert cluster_has_allocatable_gpu(nodes) is False


def test_zero_gpu_counts_as_absent():
    nodes = [{"status": {"allocatable": {"nvidia.com/gpu": "0"}}}]
    assert cluster_has_allocatable_gpu(nodes) is False


class _FakeKube:
    def __init__(self, nodes):
        self._nodes = nodes

    def list_node_allocatable(self):
        return self._nodes


def test_assert_rejects_without_gpu():
    with pytest.raises(HTTPException) as ei:
        assert_cluster_has_gpu(_FakeKube([]), skip=False)
    assert ei.value.status_code == 400
    assert "nvidia.com/gpu" in str(ei.value.detail)


def test_assert_allows_with_gpu():
    nodes = [{"status": {"allocatable": {"nvidia.com/gpu": "1"}}}]
    assert_cluster_has_gpu(_FakeKube(nodes), skip=False)


def test_assert_skip():
    assert_cluster_has_gpu(_FakeKube([]), skip=True)
