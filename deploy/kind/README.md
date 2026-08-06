# Kind cluster monitoring for CiliTrain

## metrics-server

Instant Pod CPU/memory via the Metrics API (`kubectl top`). Required for live cards.

## kube-prometheus-stack

Chart and values live in the local helm-charts tree (not pulled from the internet at deploy time):

| Path | Purpose |
|------|---------|
| `/root/helm-charts/kube-prometheus-stack` | Chart `86.1.1` (unpacked) |
| `/root/helm-charts/archives/kube-prometheus-stack-86.1.1.tgz` | Archive |
| `/root/helm-charts/kube-prometheus-stack/values-kind.yaml` | Kind slim overlay |
| `/root/helm-charts/kube-prometheus-stack/values-kind-mirror.yaml` | DaoCloud image mirrors |
| `/root/helm-charts/kube-prometheus-stack/DEPLOY-KIND.md` | Deploy notes |

```bash
helm upgrade --install kps /root/helm-charts/kube-prometheus-stack \
  -n monitoring --create-namespace \
  -f /root/helm-charts/kube-prometheus-stack/values-kind.yaml
```

If `quay.io` / `registry.k8s.io` pulls fail, add `-f .../values-kind-mirror.yaml`.

Expose Prometheus to the CiliTrain API host:

```bash
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090:9090
export CILITRAIN_PROMETHEUS_URL=http://127.0.0.1:9090
```
