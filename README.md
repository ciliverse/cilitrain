# CiliTrain

English | [中文](./README.zh-CN.md)

**CiliTrain** is a lightweight, open-source AI training platform on Kubernetes. It turns Python training scripts into standard `batch/v1` Jobs with resource guardrails, a priority queue with per-user quotas, live logs, training & Pod resource curves, `/output` artifact harvesting, a model registry with batch and online inference, and multi-run experiment comparison — without custom CRDs or in-cluster operators.

> **CiliTrain** handles *what to train, serve, and track*; **CiliKube** remains the cluster console and source of truth for nodes, workloads, and events.

## What It Does

### Training

- **Direct Job submission (`batch/v1` + `ConfigMap`)**: Edit `train.py` in the browser or pick a built-in template (`nanogpt-cpu`, `sklearn-cpu`, `monitor-demo`, `gpu-smoke`, `custom`). Scripts are mounted at `/workspace/train.py` via a Job-owned `ConfigMap`, keeping the Job YAML clean and auditable.
- **Hyperparameter form**: Templates declare typed, range-checked parameters. Each value reaches the script as `CILITRAIN_<NAME>`, and all of them as JSON in `CILITRAIN_PARAMS`.
- **Environment variables**: Up to 32 custom variables per run. Names starting with `CILITRAIN_` and `PATH` / `HOME` / `PYTHONUNBUFFERED` are reserved.
- **Dataset mount**: Mount an existing PVC at a path of your choice (default `/data`, exposed as `CILITRAIN_DATA`).
- **Resume from checkpoint**: Start a new run from a finished run's harvested checkpoint. Files are copied to `/model` and announced through `CILITRAIN_RESUME_DIR` / `CILITRAIN_RESUME_FROM`.
- **Hyperparameter sweeps**: Expand a grid (up to 8 values per parameter, 12 runs total) into queued runs, then compare them together.
- **Training & Pod resource curves**: Parses `epoch/step/loss` lines and `metrics key=value` or `/output/metrics.json` into charts, with a loss sparkline per run. Samples Pod CPU/memory from `metrics-server` or `Prometheus`, then freezes the series when the run finishes.
- **Artifact harvesting**: Keeps the container alive briefly after the script exits (`CILITRAIN_HOLD_SECONDS`) so the API can collect small files from `/output` for one-click download.
- **Experiment comparison & pipelines**: Compare 2–4 finished runs side by side, or run a shared-PVC multi-step pipeline (`preprocess → train`).

### Scheduling (the **Scheduling** page)

- **Queue instead of reject**: When a namespace is at its active-Job limit, new runs wait as `queued` and start automatically when a slot frees. The queue is capped (`CILITRAIN_MAX_QUEUED`) and stale entries are cancelled after `CILITRAIN_QUEUE_TIMEOUT_SECONDS`.
- **Priority**: Low / normal / high. Within the same priority, runs start in submission order. Only admins may set or raise to high; anyone can lower their own run.
- **Scheduled start**: Pick a start time up to 7 days ahead. The run waits until then, and can be started immediately from the Scheduling page.
- **Per-user quotas**: Optional caps on active runs and on summed CPU / memory / GPU across namespaces. Runs over quota wait in the queue; online services count toward CPU / memory.
- **One view of the cluster**: Your usage against each limit, per-namespace load, the queue in dispatch order (with reason for waiting), and everything currently running — training runs and online services.

### Models & inference

- **Model registry**: Register a finished run's artifacts as a versioned model, compare versions, and download the files.
- **Batch inference**: Run a single input or an uploaded CSV through a model as a one-off Job. Results land in `prediction.json` / `predictions.csv`.
- **Online services (the **Services** page)**: Deploy a model version as a long-running Deployment + ClusterIP Service (1–3 replicas). The model is copied into each pod and served by `examples/serve.py` on `/predict`.
  - Call it with `POST /api/serve/<id>/predict` and `Authorization: Bearer <key>` (or `X-API-Key`). Send `{"input": {...}}` or `{"inputs": [...]}` with up to 32 rows. Traffic goes through the Kubernetes API server's service proxy, so the cluster needs no Ingress.
  - API keys are shown once at creation or rotation; only a hash is stored.
  - The detail page shows readiness, a curl example, a "try it" form, request count, error rate, average latency, recent requests, and logs. You can scale, stop, start, rotate the key, or delete a stopped service.
  - At most 5 running services per user. Services never queue: if they don't fit in your quota, deployment fails with an error.

### Platform

- **Multi-cluster & RBAC**: Admins register cluster `kubeconfig` credentials once on the server and grant namespaces to `operator` or `viewer` accounts. Users never handle raw cluster credentials.
- **Resource guardrails & GPU preflight**: Per-run CPU, memory, GPU, and timeout limits. GPU jobs probe allocatable `nvidia.com/gpu` capacity before submission.
- **CiliKube deep-links**: When a CiliKube base URL is configured, each run links directly to its Job, Pod, Events, PVC, or cluster overview.
- **Showcase mode**: `CILITRAIN_SHOWCASE=1` runs a public demo against a simulated cluster with seeded runs, models, and an online service. Visitor data is reset on restart.

## Tech Stack

- **Backend**: Python 3.12+ · FastAPI · SQLModel (SQLite by default) · official `kubernetes` client · `uv`
- **Frontend**: React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · CodeMirror · `pnpm`

## Repository Layout

```text
backend/            FastAPI service, Job / Deployment builders, queue, metrics & artifact harvester
web/                React 19 SPA (Runs, New run, Scheduling, Models, Services, Pipelines, Compare, Clusters, Settings)
examples/           Built-in training / inference scripts and serve.py for online services
deploy/kind/        Minimal kube-prometheus-stack values for local Kind resource curves
```

## Quick Start

```bash
# 1. Start the API — http://0.0.0.0:8090
cd backend
uv sync --extra dev
uv run uvicorn app.main:app --host 0.0.0.0 --port 8090

# 2. Start the Web UI — http://0.0.0.0:8890 (proxies /api → :8090)
cd web
pnpm install
pnpm dev
```

1. Sign in (default dev bootstrap account: `admin` / `admin123`, configurable via `CILITRAIN_BOOTSTRAP_ADMIN_*`).
2. Open **Clusters** and register a cluster `kubeconfig` (paste YAML, upload a file, or enter a path readable by the API host). Optionally set the **CiliKube** console URL (e.g. `https://cilikube.example.com`) on the same page.
3. Open **New run**, select a template, adjust parameters, priority, or start time, and submit. If the namespace is busy, the run is queued — watch it on **Scheduling**.
4. Watch live logs, training curves, Pod CPU/memory, and harvested `/output` files on the run detail page. Use **Clean leftover** after failures such as `ImagePullBackOff` to free the slot.
5. Register a finished run as a model under **Models**, try inference, then choose **Deploy as service** to get an HTTP endpoint and API key.

For production, build the UI (`pnpm --dir web build`) and set `CILITRAIN_STATIC_DIR=web/dist` so the API serves it on the same port.

## Configuration (`CILITRAIN_*`)

| Variable | Default | Description |
| --- | --- | --- |
| `CILITRAIN_DATA_DIR` | `~/.cilitrain` | SQLite database, logs, frozen metrics, harvested artifacts, and models |
| `CILITRAIN_MAX_CPU` | `8.0` | Maximum CPU cores per run (and per service replica) |
| `CILITRAIN_MAX_MEMORY_GI` | `16.0` | Maximum memory (GiB) per run (and per service replica) |
| `CILITRAIN_MAX_GPU` | `2` | Maximum `nvidia.com/gpu` count per run |
| `CILITRAIN_DEFAULT_TIMEOUT_SECONDS` | `7200` | Maximum Job `activeDeadlineSeconds` (2 hours) |
| `CILITRAIN_DEFAULT_CONCURRENCY` | `3` | Maximum active Jobs per namespace; extra runs queue |
| `CILITRAIN_MAX_QUEUED` | `20` | Maximum queued runs per namespace |
| `CILITRAIN_QUEUE_TIMEOUT_SECONDS` | `86400` | Queued runs older than this are cancelled (counted from the scheduled start, if any) |
| `CILITRAIN_USER_MAX_ACTIVE` | `0` | Active runs per user across namespaces (`0` = no cap) |
| `CILITRAIN_USER_MAX_CPU` | `0` | Summed CPU cores per user, runs + services (`0` = no cap) |
| `CILITRAIN_USER_MAX_MEMORY_GI` | `0` | Summed memory (GiB) per user, runs + services (`0` = no cap) |
| `CILITRAIN_USER_MAX_GPU` | `0` | Summed GPUs per user (`0` = no cap) |
| `CILITRAIN_HOLD_SECONDS` | `45` | Seconds to keep the container alive after training exits for `/output` collection |
| `CILITRAIN_MAX_MODEL_MB` | `200` | Largest model a run may register |
| `CILITRAIN_PROMETHEUS_URL` | `http://127.0.0.1:9090` | Prometheus endpoint for Pod CPU/memory curves (falls back to `metrics-server`) |
| `CILITRAIN_STATIC_DIR` | *(empty)* | Built web assets to serve from the API |
| `CILITRAIN_SHOWCASE` | *(off)* | Public demo mode with a simulated cluster |
| `CILITRAIN_SHOWCASE_ADMIN_PASSWORD` / `CILITRAIN_SHOWCASE_GUEST_PASSWORD` | *(placeholders)* | Demo account passwords shown on the showcase login page |
| `CILITRAIN_JWT_SECRET` | *(auto/dev)* | HMAC secret for session tokens (set a ≥32-byte secret in production) |

## License

Apache-2.0 · [ciliverse](https://github.com/ciliverse)
