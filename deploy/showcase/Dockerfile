# Public exhibit image: built web UI and the API on one port.
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
COPY web/ ./
RUN pnpm install --frozen-lockfile && pnpm build

FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY backend/pyproject.toml backend/uv.lock /app/backend/
WORKDIR /app/backend
RUN uv sync --frozen --no-dev
COPY backend/app /app/backend/app
COPY examples /app/examples
COPY --from=web /src/web/dist /app/web
ENV CILITRAIN_STATIC_DIR=/app/web
ENV CILITRAIN_DATA_DIR=/data
EXPOSE 8890
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8890"]
