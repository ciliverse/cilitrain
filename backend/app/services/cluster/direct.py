"""Direct kubeconfig Kubernetes adapter."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from app.models.entities import Cluster


def _normalize_log_text(raw: Any) -> str:
    """Kubernetes client may return str, bytes, or a bogus repr like \"b''\"."""
    import ast

    if raw is None:
        return ""
    if isinstance(raw, (bytes, bytearray)):
        return raw.decode("utf-8", errors="replace")
    text = str(raw)
    if text in {"b''", 'b""', "b''\n", 'b""\n'}:
        return ""
    if len(text) >= 3 and text[0] == "b" and text[1] in {"'", '"'}:
        try:
            decoded = ast.literal_eval(text)
            if isinstance(decoded, (bytes, bytearray)):
                return decoded.decode("utf-8", errors="replace")
        except (ValueError, SyntaxError):
            pass
    return text


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

    def create_pvc(
        self,
        namespace: str,
        name: str,
        *,
        size: str = "1Gi",
        access_modes: list[str] | None = None,
        labels: dict[str, str] | None = None,
    ) -> Any:
        """Create a PVC using the cluster default StorageClass (Kind-friendly)."""
        body = {
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "labels": labels
                or {
                    "cilitrain.io/managed-by": "cilitrain",
                },
            },
            "spec": {
                "accessModes": access_modes or ["ReadWriteOnce"],
                "resources": {"requests": {"storage": size}},
            },
        }
        try:
            return self.core.create_namespaced_persistent_volume_claim(
                namespace=namespace, body=body
            )
        except ApiException as exc:
            if exc.status == 409:
                # Already exists — reuse
                try:
                    return self.core.read_namespaced_persistent_volume_claim(name, namespace)
                except ApiException as read_exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"pvc exists but unreadable: {read_exc.status} {read_exc.reason}",
                    ) from read_exc
            raise HTTPException(
                status_code=502,
                detail=f"create pvc failed: {exc.status} {exc.reason} {exc.body}",
            ) from exc

    def delete_job(self, namespace: str, name: str) -> None:
        """Delete Job and cascade pods (Kubeflow training-client style)."""
        try:
            self.batch.delete_namespaced_job(
                name=name,
                namespace=namespace,
                propagation_policy="Background",
                grace_period_seconds=0,
            )
        except ApiException as exc:
            if exc.status == 404:
                return
            raise HTTPException(
                status_code=502,
                detail=f"delete job failed: {exc.status} {exc.reason} {exc.body}",
            ) from exc

    def suspend_job(self, namespace: str, name: str) -> None:
        """Pause Job via spec.suspend (K8s Job / Kubeflow TrainJob pattern)."""
        try:
            self.batch.patch_namespaced_job(
                name=name,
                namespace=namespace,
                body={"spec": {"suspend": True}},
            )
        except ApiException as exc:
            if exc.status == 404:
                return
            raise HTTPException(
                status_code=502,
                detail=f"suspend job failed: {exc.status} {exc.reason} {exc.body}",
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
            raw = self.core.read_namespaced_pod_log(
                name=pod_name,
                namespace=namespace,
                container="trainer",
                tail_lines=tail,
                timestamps=True,
                _preload_content=True,
            )
            text = _normalize_log_text(raw)
            if not text.strip():
                # previous empty responses sometimes surface as the literal "b''"
                return ""
            return text
        except ApiException as exc:
            if exc.status in (400, 404):
                return f"(logs not ready: {exc.reason})"
            raise HTTPException(
                status_code=502,
                detail=f"read logs failed: {exc.status} {exc.reason}",
            ) from exc

    def pod_snapshot(self, namespace: str, run_id: str) -> dict[str, Any]:
        pods = self.list_job_pods(namespace, run_id)
        if not pods:
            return {
                "pod_name": None,
                "pod_phase": None,
                "status_reason": "WaitingForPod",
                "status_message": "Job created; waiting for Pod",
            }
        pod = sorted(pods, key=lambda p: p.metadata.creation_timestamp or 0)[-1]
        phase = pod.status.phase if pod.status else None
        reason = None
        message = None
        if pod.status and pod.status.container_statuses:
            cs = pod.status.container_statuses[0]
            state = cs.state
            if state.waiting:
                reason = state.waiting.reason or "Waiting"
                message = state.waiting.message
            elif state.terminated:
                reason = state.terminated.reason or "Terminated"
                message = state.terminated.message or f"exit={state.terminated.exit_code}"
            elif state.running:
                reason = "Running"
                message = f"startedAt={state.running.started_at}"
        elif pod.status and pod.status.conditions:
            # e.g. PodScheduled false
            cond = pod.status.conditions[-1]
            reason = cond.reason or phase
            message = cond.message
        return {
            "pod_name": pod.metadata.name,
            "pod_phase": phase,
            "status_reason": reason or phase,
            "status_message": message,
        }

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

    def list_node_allocatable(self) -> list[dict[str, Any]]:
        """Return nodes as plain dicts with status.allocatable for GPU probing."""
        try:
            res = self.core.list_node()
        except ApiException as exc:
            raise HTTPException(
                status_code=400,
                detail=f"GPU probe failed (list nodes): {exc.status} {exc.reason}",
            ) from exc
        out: list[dict[str, Any]] = []
        for node in res.items or []:
            allocatable: dict[str, str] = {}
            status = getattr(node, "status", None)
            raw_alloc = getattr(status, "allocatable", None) if status else None
            if raw_alloc:
                # client may return dict-like Quantity map
                for key, val in dict(raw_alloc).items():
                    allocatable[str(key)] = str(val)
            out.append({"status": {"allocatable": allocatable}})
        return out

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
