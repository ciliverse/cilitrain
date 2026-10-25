# CiliTrain

[English](./README.md) | 中文

**CiliTrain** 是面向 Kubernetes 的轻量级开源 AI 训练平台。它把 Python 训练脚本直接封装为原生 `batch/v1 Job` 与 `ConfigMap`，在不引入自定义 Operator / CRD 的前提下，提供资源护栏、带优先级的排队与个人配额、实时日志、训练指标与 Pod 资源曲线、`/output` 产物回收、模型库与批量 / 在线推理，以及多实验对比。

> **CiliTrain** 负责「训什么、怎么上线、怎么对比」；**CiliKube** 负责「集群真相与节点/工作负载运维排障」。

## 核心能力

### 训练

- **原生 Job 提交（`batch/v1` + `ConfigMap`）**：内置 `nanogpt-cpu`、`sklearn-cpu`、`monitor-demo`、`gpu-smoke`、`custom` 等模板，可在网页编辑器中直接修改 `train.py`。脚本通过与 Job 同生命周期的 `ConfigMap` 挂载到 `/workspace/train.py`，生成的 Job YAML 干净可读。
- **超参数表单**：模板声明带类型和取值范围的参数。每个参数以 `CILITRAIN_<参数名>` 传给脚本，全部参数另以 JSON 放在 `CILITRAIN_PARAMS`。
- **环境变量**：每个任务最多 32 个自定义变量。`CILITRAIN_` 开头的名字以及 `PATH` / `HOME` / `PYTHONUNBUFFERED` 为平台保留。
- **数据集挂载**：把已有 PVC 挂到指定路径（默认 `/data`，脚本里用 `CILITRAIN_DATA` 读取）。
- **断点续训**：从已结束任务回收的 checkpoint 继续训练。文件拷到 `/model`，并通过 `CILITRAIN_RESUME_DIR` / `CILITRAIN_RESUME_FROM` 告知脚本。
- **超参数搜索**：按网格展开（每个参数最多 8 个取值，总共最多 12 个任务），统一排队，结束后一起对比。
- **训练曲线与 Pod 资源监控**：从标准输出（`epoch/step/loss` 或 `metrics key=value`）和 `/output/metrics.json` 解析训练曲线，任务列表显示 loss 走势；结合 `metrics-server` 或 `Prometheus` 绘制 Pod CPU / 内存曲线，任务结束后冻结历史序列。
- **训练产物自动回收**：训练进程退出后短暂保留容器（`CILITRAIN_HOLD_SECONDS`），后端从 `/output` 回收指标、checkpoint、样本等小文件，详情页可直接下载。
- **实验对比与训练流水线**：勾选 2～4 个已结束任务并排对比规格、指标与曲线；支持基于共享 PVC 的多步流水线（`preprocess → train`）。

### 调度（「调度」页）

- **排队而不是拒绝**：命名空间活跃 Job 达到上限时，新任务进入 `queued`，有空位自动启动。队列长度有上限（`CILITRAIN_MAX_QUEUED`），排队超过 `CILITRAIN_QUEUE_TIMEOUT_SECONDS` 自动取消。
- **优先级**：低 / 普通 / 高，同一优先级按提交顺序。只有管理员能设为或调到高；任何人都可以调低自己的任务。
- **定时启动**：设置 7 天以内的启动时间，到点后进入排队；也可以在调度页立即开始。
- **个人配额**：可选限制每人跨命名空间的运行任务数，以及 CPU / 内存 / GPU 合计。超出配额的任务排队等待；在线服务计入 CPU / 内存。
- **一页看清**：我的用量与各项上限、各命名空间负载、按派发顺序排列的队列（附等待原因），以及正在运行的训练任务和在线服务。

### 模型与推理

- **模型库**：把已结束任务的产物注册为带版本的模型，可对比版本、下载文件。
- **批量推理**：单条输入或上传 CSV，作为一次性 Job 推理，结果写入 `prediction.json` / `predictions.csv`。
- **在线服务（「服务」页）**：把模型版本部署成常驻 Deployment + ClusterIP Service（1～3 个副本）。模型拷进每个 Pod，由 `examples/serve.py` 提供 `/predict`。
  - 调用 `POST /api/serve/<id>/predict`，请求头带 `Authorization: Bearer <key>`（或 `X-API-Key`）。请求体为 `{"input": {...}}`，或最多 32 条的 `{"inputs": [...]}`。流量经 Kubernetes API Server 的 service proxy 转发，集群不需要 Ingress。
  - API Key 只在创建或重新生成时显示一次，平台只保存哈希。
  - 详情页显示就绪状态、curl 示例、在线试用、请求数、错误率、平均延迟、最近请求和日志；可以改副本数、停止、启动、重新生成 Key，停止后可删除。
  - 每人同时最多运行 5 个服务。服务不排队：放不进个人配额时，部署直接报错。

### 平台

- **多集群凭证托管与权限控制**：管理员在服务端统一登记 `kubeconfig`，按「集群 + 命名空间」授权给 `operator`（可提交/管理）或 `viewer`（只读）账号，普通用户无需接触集群凭证。
- **资源护栏与 GPU 预检**：校验单任务 CPU、内存、GPU 与超时上限；请求 GPU 时探测集群可分配的 `nvidia.com/gpu`。
- **联动 CiliKube 排障**：配置 CiliKube 地址后，可从任务直接跳到对应的 Job、Pod、事件、PVC 或集群总览。
- **演示模式**：`CILITRAIN_SHOWCASE=1` 以模拟集群运行公开演示，预置训练任务、模型和一个在线服务；重启后清空访客数据。

## 技术栈

- **后端**：Python 3.12+ · FastAPI · SQLModel（默认 SQLite）· Kubernetes 官方 Python 客户端 · `uv`
- **前端**：React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · CodeMirror · `pnpm`

## 目录结构

```text
backend/            FastAPI 服务端、Job / Deployment 清单构建、排队调度、指标解析与产物采集
web/                React 19 前端（训练任务、新建训练、调度、模型、服务、流水线、对比、集群管理、设置）
examples/           内置训练 / 推理脚本，以及在线服务用的 serve.py
deploy/kind/        Kind 集群轻量监控配置（kube-prometheus-stack 精简 values）
```

## 快速开始

```bash
# 1. 启动后端 API — http://0.0.0.0:8090
cd backend
uv sync --extra dev
uv run uvicorn app.main:app --host 0.0.0.0 --port 8090

# 2. 启动前端 Web — http://0.0.0.0:8890（自动代理 /api → :8090）
cd web
pnpm install
pnpm dev
```

1. 打开前端并登录（开发默认管理员：`admin` / `admin123`，可通过 `CILITRAIN_BOOTSTRAP_ADMIN_*` 修改）。
2. 进入 **集群管理**，粘贴或上传 `kubeconfig`（也可填写 API 所在机器可读的路径）。同一页可按需填写 **CiliKube** 控制台地址（如 `https://cilikube.example.com`）。
3. 进入 **新建训练**，选模板、调参数、优先级或定时启动后提交。命名空间忙时任务会排队，可在 **调度** 页查看。
4. 在任务详情页查看实时日志、训练曲线、Pod CPU/内存与 `/output` 产物。遇到 `ImagePullBackOff` 等失败时，点 **清理残留** 释放名额。
5. 在 **模型** 里把已结束任务注册为模型、试推理，再点 **部署为在线服务** 拿到 HTTP 接口和 API Key。

生产环境先构建前端（`pnpm --dir web build`），再设置 `CILITRAIN_STATIC_DIR=web/dist`，由 API 在同一端口提供页面。

## 环境变量与护栏配置（`CILITRAIN_*`）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `CILITRAIN_DATA_DIR` | `~/.cilitrain` | SQLite 数据库、日志、冻结曲线、回收产物与模型的存储目录 |
| `CILITRAIN_MAX_CPU` | `8.0` | 单任务（以及服务单副本）最大 CPU 核数 |
| `CILITRAIN_MAX_MEMORY_GI` | `16.0` | 单任务（以及服务单副本）最大内存（GiB） |
| `CILITRAIN_MAX_GPU` | `2` | 单任务最大 `nvidia.com/gpu` 数量 |
| `CILITRAIN_DEFAULT_TIMEOUT_SECONDS` | `7200` | 单任务最大超时（秒，默认 2 小时） |
| `CILITRAIN_DEFAULT_CONCURRENCY` | `3` | 单命名空间同时运行的 Job 上限，超出的排队 |
| `CILITRAIN_MAX_QUEUED` | `20` | 单命名空间最多排队任务数 |
| `CILITRAIN_QUEUE_TIMEOUT_SECONDS` | `86400` | 排队超过该时长自动取消（有定时启动时从启动时间算起） |
| `CILITRAIN_USER_MAX_ACTIVE` | `0` | 每人跨命名空间同时运行的任务数（`0` 为不限） |
| `CILITRAIN_USER_MAX_CPU` | `0` | 每人 CPU 合计，任务 + 服务（`0` 为不限） |
| `CILITRAIN_USER_MAX_MEMORY_GI` | `0` | 每人内存合计（GiB），任务 + 服务（`0` 为不限） |
| `CILITRAIN_USER_MAX_GPU` | `0` | 每人 GPU 合计（`0` 为不限） |
| `CILITRAIN_HOLD_SECONDS` | `45` | 训练退出后容器保持运行以采集 `/output` 的秒数 |
| `CILITRAIN_MAX_MODEL_MB` | `200` | 可注册模型的最大体积 |
| `CILITRAIN_PROMETHEUS_URL` | `http://127.0.0.1:9090` | Prometheus 地址（不可达时回退到 `metrics-server`） |
| `CILITRAIN_STATIC_DIR` | *(空)* | 由 API 托管的前端构建产物目录 |
| `CILITRAIN_SHOWCASE` | *(关闭)* | 公开演示模式，使用模拟集群 |
| `CILITRAIN_SHOWCASE_ADMIN_PASSWORD` / `CILITRAIN_SHOWCASE_GUEST_PASSWORD` | *(占位值)* | 演示登录页展示的两个演示账号密码 |
| `CILITRAIN_JWT_SECRET` | *(开发默认)* | 登录会话签名密钥（生产环境请配置至少 32 字节随机串） |

## 许可证

Apache-2.0 · [ciliverse](https://github.com/ciliverse)
