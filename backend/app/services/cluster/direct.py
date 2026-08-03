"""Direct kubeconfig Kubernetes adapter."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from app.models.entities import Cluster


class DirectKube:
    def __init__(self, cluster: Cluster) -> None:
        self.cluster = cluster
        self._api_client = self._build_api_client()
        self.batch = client.BatchV1Api(self._api_client)
        self.core = client.CoreV1Api(self._api_client)

    def _build_api_client(self) -> client.ApiClient:
        configuration = client.Configuration()
        tmp_path: str | None = None
        try:
            if self.cluster.kubeconfig_content:
                with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as fh:
                    fh.write(self.cluster.kubeconfig_content)
                    tmp_path = fh.name
                config.load_kube_config(
                    config_file=tmp_path,
                    context=self.cluster.context or None,
                    client_configuration=configuration,
                )
            elif self.cluster.kubeconfig_path:
                path = Path(self.cluster.kubeconfig_path).expanduser()
                if not path.exists():
                    raise HTTPException(status_code=400, detail=f"kubeconfig not found: {path}")
                config.load_kube_config(
                    config_file=str(path),
                    context=self.cluster.context or None,
                    client_configuration=configuration,
                )
            else:
                raise HTTPException(status_code=400, detail="cluster has no kubeconfig")
            return client.ApiClient(configuration)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"kubeconfig load failed: {exc}") from exc
        finally:
            if tmp_path:
                try:
                    Path(tmp_path).unlink(missing_ok=True)
                except OSError:
                    pass

    def create_job(self, body: dict[str, Any]) -> Any:
        ns = body["metadata"]["namespace"]
        try:
            return self.batch.create_namespaced_job(namespace=ns, body=body)
        except ApiException as exc:
            raise HTTPException(
                status_code=502,
                detail=f"create job failed: {exc.status} {exc.reason} {exc.body}",
            ) from exc

    def get_job(self, namespace: str, name: str) -> Any | None:
        try:
            return self.batch.read_namespaced_job(name=name, namespace=namespace)
        except ApiException as exc:
            if exc.status == 404:
                return None
            raise HTTPException(
                status_code=502,
                detail=f"get job failed: {exc.status} {exc.reason}",
            ) from exc

    def list_job_pods(self, namespace: str, run_id: str) -> list[Any]:
        label = f"cilitrain.io/run={run_id}"
        try:
            res = self.core.list_namespaced_pod(namespace=namespace, label_selector=label)
            return list(res.items or [])
        except ApiException as exc:
            raise HTTPException(
                status_code=502,
                detail=f"list pods failed: {exc.status} {exc.reason}",
            ) from exc

    def pod_logs(self, namespace: str, pod_name: str, tail: int = 500) -> str:
        try:
            return self.core.read_namespaced_pod_log(
                name=pod_name,
                namespace=namespace,
                tail_lines=tail,
                timestamps=True,
            )
        except ApiException as exc:
            if exc.status in (400, 404):
                return f"(logs not ready: {exc.reason})"
            raise HTTPException(
                status_code=502,
                detail=f"read logs failed: {exc.status} {exc.reason}",
            ) from exc

    def list_events(self, namespace: str, involved_name: str) -> list[str]:
        try:
            res = self.core.list_namespaced_event(
                namespace=namespace,
                field_selector=f"involvedObject.name={involved_name}",
            )
            items = list(res.items or [])
            out: list[str] = []
            for ev in items[-20:]:
                out.append(f"{ev.type}: {ev.reason}: {ev.message}")
            return out
        except ApiException:
            return []

    def count_active_jobs(self, namespace: str) -> int:
        try:
            res = self.batch.list_namespaced_job(
                namespace=namespace,
                label_selector="cilitrain.io/managed-by=cilitrain",
            )
        except ApiException as exc:
            raise HTTPException(
                status_code=502,
                detail=f"list jobs failed: {exc.status} {exc.reason}",
            ) from exc
        n = 0
        for job in res.items or []:
            st = job.status
            if not st:
                n += 1
                continue
            if (st.active or 0) > 0:
                n += 1
            elif not st.completion_time and not (st.failed or 0) and not (st.succeeded or 0):
                n += 1
        return n
