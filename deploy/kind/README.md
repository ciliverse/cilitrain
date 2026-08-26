# Kind cluster monitoring for CiliTrain

Live resource cards need cluster metrics. Install these on the Kind cluster, then point the API at Prometheus.

## metrics-server

Instant Pod CPU and memory via the Metrics API (`kubectl top`). Required for the live cards.

## kube-prometheus-stack

`kube-prometheus-stack-slim.yaml` in this directory is a small overlay: short retention, modest requests, and no Alertmanager or Grafana. It targets the upstream `kube-prometheus-stack` chart (86.x).

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  -f deploy/kind/kube-prometheus-stack-slim.yaml
```

Run that from the repository root. If image pulls from `quay.io` or `registry.k8s.io` fail, add your own values file that points those images at a mirror you control.

Expose Prometheus to the host running the CiliTrain API:

```bash
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090:9090
export CILITRAIN_PROMETHEUS_URL=http://127.0.0.1:9090
```
