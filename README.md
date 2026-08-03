# CiliTrain

Open-source AI training on Kubernetes.  
**CiliTrain** submits and tracks training Jobs; **CiliKube** remains the cluster console / source of truth.

> CiliTrain 管「训什么、怎么提交」；CiliKube 管「集群真相与运维排障」。

## Stack

- Backend: Python 3.12+ · FastAPI · SQLModel · kubernetes client · uv
- Frontend: React 19 · TypeScript · Vite 8 · Tailwind 4 · pnpm

## Quick start

```bash
# API — http://0.0.0.0:8090
cd backend && uv sync --extra dev && uv run uvicorn app.main:app --host 0.0.0.0 --port 8090

# Web — http://0.0.0.0:8890  (proxies /api → :8090)
cd web && pnpm install && pnpm dev
```

1. Open the web UI → **Settings** → add a Direct cluster (`kubeconfig` path or paste).
2. **New run** → pick `sklearn-cpu` or `custom` → submit.
3. Watch status + logs on the run detail page.

Optional: set CiliKube base URL in Settings for deep-links only (v0.1 does not proxy submit).

## Guardrails (v0.1)

CPU ≤ 2 · memory ≤ 4Gi · timeout ≤ 2h · concurrency 3 per namespace

## License

Apache-2.0 · [ciliverse](https://github.com/ciliverse)
