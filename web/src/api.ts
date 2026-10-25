export type Cluster = {
  id: string
  name: string
  context?: string | null
  kubeconfig_path?: string | null
  has_kubeconfig_content: boolean
  cilikube_base_url?: string | null
  simulated?: boolean
  created_at: string
}

export type ClusterProbe = {
  cluster_id: string
  name: string
  reachable: boolean
  message?: string | null
  gpu_allocatable?: number | null
}

export type Template = {
  id: string
  name: string
  description: string
  image: string
  command: string[]
  args: string[]
  cpu: string
  memory: string
  timeout_seconds: number
  gpu_count?: number
  kind?: string
  script?: string | null
  params?: ParamField[]
  resumable?: boolean
}

export type ParamField = {
  key: string
  type: 'int' | 'float' | 'text'
  default?: number | string
  min?: number
  max?: number
  max_len?: number
}

export type CiliKubeLinks = {
  configured: boolean
  console?: string | null
  job?: string | null
  pod?: string | null
  events?: string | null
  pvc?: string | null
}

export type Run = {
  id: string
  cluster_id: string
  name: string
  namespace: string
  template: string
  image: string
  command: string[]
  args: string[]
  cpu: string
  memory: string
  gpu_count?: number
  timeout_seconds: number
  pvc_name?: string | null
  status: string
  job_name?: string | null
  pod_name?: string | null
  pod_phase?: string | null
  status_reason?: string | null
  status_message?: string | null
  duration_seconds?: number | null
  error_message?: string | null
  job_yaml?: string | null
  script?: string | null
  simulated?: boolean
  showcase_seed?: boolean
  kind?: 'train' | 'infer'
  model_id?: string | null
  model_label?: string | null
  infer_input?: Record<string, string | number> | null
  batch_rows?: number | null
  prediction?: Prediction | null
  registrable?: boolean
  registered_models?: { id: string; label: string }[]
  params?: Record<string, number | string>
  env?: Record<string, string>
  pvc_mount_path?: string
  resume_from?: string | null
  resume_from_name?: string | null
  resumable?: boolean
  sweep_id?: string | null
  queue_position?: number | null
  queue_reason?: QueueReason | null
  priority?: Priority
  not_before?: string | null
  started_at?: string | null
  created_at: string
  updated_at: string
  finished_at?: string | null
  cilikube_url?: string | null
  cilikube_links?: CiliKubeLinks
  events: string[]
}

export type Prediction =
  | { type: 'text'; text: string; prompt?: string; new_tokens?: number; dropped_chars?: number }
  | { type: 'classification'; label: string; probabilities: Record<string, number> }
  | BatchPrediction
  | { type?: undefined; [k: string]: unknown }

export type BatchPrediction = {
  type: 'batch'
  output: 'classification' | 'text'
  rows: number
  file: string
  counts?: Record<string, number>
  sample: { input: Record<string, string | number>; label?: string; confidence?: number; generated?: string }[]
}

export type InferField = {
  key: string
  type: 'text' | 'int' | 'float'
  default?: string | number
  min?: number
  max?: number
  max_len?: number
}

export type InferSpec = {
  output: 'text' | 'classification'
  fields: InferField[]
  batch_max_rows?: number
  cpu?: string
  memory?: string
  timeout_seconds?: number
}

export type ModelVersion = {
  id: string
  name: string
  version: number
  label: string
  template: string
  source_run_id?: string | null
  source_run_name?: string | null
  source_params?: Record<string, number | string>
  files: { path: string; size: number }[]
  size_bytes: number
  metrics: Record<string, number | string>
  infer?: InferSpec | null
  infer_count: number
  showcase_seed?: boolean
  created_at: string
}

export type ServiceStatus = 'starting' | 'running' | 'stopped' | 'failed'

export type ServiceRequest = { at: string; ok: boolean; latency_ms: number; rows: number; summary: string }

export type InferenceService = {
  id: string
  name: string
  model_id: string
  model_label?: string | null
  template: string
  cluster_id: string
  cluster_name?: string | null
  namespace: string
  owner_user_id?: string | null
  image: string
  cpu: string
  memory: string
  replicas: number
  ready_replicas: number
  status: ServiceStatus
  status_message?: string | null
  simulated: boolean
  error_message?: string | null
  api_key_prefix?: string | null
  endpoint_path: string
  requests: number
  errors: number
  avg_latency_ms?: number | null
  last_request_at?: string | null
  infer?: InferSpec | null
  recent: ServiceRequest[]
  created_at: string
  started_at?: string | null
  stopped_at?: string | null
}

export type ServiceWithKey = { service: InferenceService; api_key: string }

export type ServicePrediction = { output?: Prediction; outputs?: Prediction[]; latency_ms: number }

export type MetricsView = {
  run_id: string
  name?: string
  status?: string
  summary: Record<string, number>
  series: Record<string, number>[]
  chart_keys: string[]
  x_key?: string
  artifacts: { path: string; size: number }[]
  harvest?: { status?: string; files?: number; marker?: boolean }
  resource?: {
    available: boolean
    pending?: boolean
    message?: string | null
    cpu?: string | null
    memory?: string | null
    cpu_cores?: number | null
    memory_mi?: number | null
    pod_name?: string
    prometheus?: boolean
    frozen?: boolean
    series_source?: 'prometheus' | 'metrics-server' | string
    series?: Record<string, number>[]
    nodes?: { name?: string; cpu?: string; memory?: string }[]
  }
}

export type RunTrend = { key: string; points: number[]; last: number }

export type Pipeline = {
  id: string
  name: string
  cluster_id: string
  namespace: string
  status: string
  current_step: number
  steps: Record<string, unknown>[]
  run_ids: string[]
  pvc_name?: string | null
  error_message?: string | null
  created_at: string
  updated_at: string
  finished_at?: string | null
}

type QuotaKeys = { active: number; cpu: number; memory_gi: number; gpu: number }

export type SchedulerInfo = {
  concurrency: number
  max_queued: number
  queue_timeout_seconds: number
  /** 0 means no cap */
  quota: QuotaKeys
  usage: QuotaKeys
  my_queued: number
  namespaces: { cluster_id: string; cluster_name: string; namespace: string; active: number; queued: number }[]
  queue: SchedulerItem[]
  active: SchedulerItem[]
}

export type QueueReason = 'namespace' | 'user_active' | 'user_quota' | 'scheduled'
/** -1 low, 0 normal, 1 high (admin only) */
export type Priority = -1 | 0 | 1

export type SchedulerItem = {
  id: string
  kind: 'train' | 'infer' | 'service'
  name: string
  owner?: string | null
  mine: boolean
  cluster_name: string
  namespace: string
  status: string
  priority: Priority
  queue_reason?: QueueReason | null
  queue_position?: number | null
  not_before?: string | null
  cpu: string
  memory: string
  gpu_count: number
  created_at: string
  started_at?: string | null
}

export type ShowcaseAccount = {
  username: string
  password: string
  role: string
}

export type ShowcaseInfo = {
  showcase: boolean
  message?: string
  cluster?: string
  accounts?: ShowcaseAccount[]
}

/** Public. Accounts are present only when the server runs with showcase mode on. */
export async function fetchShowcase(): Promise<ShowcaseInfo> {
  try {
    const res = await fetch('/api/showcase')
    if (!res.ok) return { showcase: false }
    const data = (await res.json()) as ShowcaseInfo
    return data?.showcase ? data : { showcase: false }
  } catch {
    return { showcase: false }
  }
}

const TOKEN_KEY = 'cilitrain_token'

export type AuthUser = {
  id: string
  username: string
  role: string
  is_active: boolean
  must_change_password: boolean
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** Fetch with the session token and save the response as a file. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const token = getToken()
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail || detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '')
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = named ? decodeURIComponent(named[1]) : fallbackName
  link.click()
  URL.revokeObjectURL(url)
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    setToken(null)
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login'
    }
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail || JSON.stringify(body)
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  health: () => req<{ status: string }>('/api/health'),
  authStatus: () =>
    req<{ auth_disabled: boolean; auth_required: boolean; has_users: boolean }>('/api/auth/status'),
  login: (username: string, password: string) =>
    req<{ access_token: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ status: string }>('/api/auth/logout', { method: 'POST' }),
  me: () => req<AuthUser>('/api/auth/me'),
  users: () => req<AuthUser[]>('/api/users'),
  createUser: (body: { username: string; password: string; role: string }) =>
    req<AuthUser>('/api/users', { method: 'POST', body: JSON.stringify(body) }),
  addGrant: (userId: string, cluster_id: string, namespace: string) =>
    req(`/api/users/${userId}/grants`, {
      method: 'POST',
      body: JSON.stringify({ cluster_id, namespace }),
    }),
  templates: () => req<Template[]>('/api/templates'),
  clusters: () => req<Cluster[]>('/api/clusters'),
  clusterProbe: (id: string) => req<ClusterProbe>(`/api/clusters/${id}/probe`),
  createCluster: (body: Record<string, unknown>) =>
    req<Cluster>('/api/clusters', { method: 'POST', body: JSON.stringify(body) }),
  deleteCluster: (id: string) => req<{ status: string }>(`/api/clusters/${id}`, { method: 'DELETE' }),
  settings: () =>
    req<{
      cilikube_base_url?: string | null
      cilikube_configured?: boolean
      max_gpu?: number
      max_cpu?: number
      max_memory_gi?: number
      default_concurrency?: number
      max_queued?: number
      user_max_active?: number
      user_max_cpu?: number
      user_max_memory_gi?: number
      user_max_gpu?: number
      queue_timeout_seconds?: number
      prometheus_url?: string | null
    }>('/api/settings'),
  scheduler: () => req<SchedulerInfo>('/api/scheduler'),
  putSettings: (cilikube_base_url: string | null) =>
    req<{ cilikube_base_url?: string | null; cilikube_configured?: boolean; max_gpu?: number }>(
      '/api/settings',
      {
        method: 'PUT',
        body: JSON.stringify({ cilikube_base_url }),
      },
    ),
  runs: () => req<Run[]>('/api/runs'),
  run: (id: string) => req<Run>(`/api/runs/${id}`),
  createRun: (body: Record<string, unknown>) =>
    req<Run>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  createSweep: (run: Record<string, unknown>, grid: Record<string, (number | string)[]>) =>
    req<{ sweep_id: string; runs: Run[] }>('/api/sweeps', {
      method: 'POST',
      body: JSON.stringify({ run, grid }),
    }),
  cancelRun: (id: string) => req<Run>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  setRunPriority: (id: string, priority: Priority) =>
    req<Run>(`/api/runs/${id}/priority`, { method: 'PUT', body: JSON.stringify({ priority }) }),
  startRunNow: (id: string) => req<Run>(`/api/runs/${id}/start-now`, { method: 'POST' }),
  cleanupRun: (id: string) =>
    req<{ status: string; cleaned: boolean }>(`/api/runs/${id}/cleanup`, { method: 'POST' }),
  rerunRun: (id: string) => req<Run>(`/api/runs/${id}/rerun`, { method: 'POST' }),
  deleteRun: (id: string) => req<{ status: string }>(`/api/runs/${id}`, { method: 'DELETE' }),
  logs: (id: string) => req<{ pod_name?: string | null; logs: string }>(`/api/runs/${id}/logs`),
  metrics: (id: string) => req<MetricsView>(`/api/runs/${id}/metrics`),
  runTrends: (ids: string[]) =>
    req<{ trends: Record<string, RunTrend> }>(
      `/api/run-trends?ids=${ids.map(encodeURIComponent).join(',')}`,
    ),
  artifacts: (id: string) =>
    req<{ run_id: string; items: { path: string; size: number }[] }>(`/api/runs/${id}/artifacts`),
  artifactUrl: (id: string, path: string) =>
    `/api/runs/${id}/artifacts/file?path=${encodeURIComponent(path)}`,
  compare: (ids: string[]) =>
    req<{
      runs: Run[]
      comparison: { metric_keys: string[]; rows: Record<string, unknown>[] }
      metrics: Record<string, MetricsView>
    }>(`/api/compare/runs?ids=${ids.map(encodeURIComponent).join(',')}`),
  models: () => req<ModelVersion[]>('/api/models'),
  model: (id: string) => req<ModelVersion>(`/api/models/${id}`),
  modelRuns: (id: string) => req<Run[]>(`/api/models/${id}/runs`),
  registerModel: (runId: string, name: string) =>
    req<ModelVersion>(`/api/runs/${runId}/register-model`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  infer: (modelId: string, input: Record<string, string | number>) =>
    req<Run>(`/api/models/${modelId}/infer`, { method: 'POST', body: JSON.stringify({ input }) }),
  inferBatch: (modelId: string, csv: string) =>
    req<Run>(`/api/models/${modelId}/infer-batch`, { method: 'POST', body: JSON.stringify({ csv }) }),
  modelDownloadUrl: (modelId: string) => `/api/models/${modelId}/download`,
  services: () => req<InferenceService[]>('/api/services'),
  service: (id: string) => req<InferenceService>(`/api/services/${id}`),
  createService: (body: { model_id: string; name?: string; replicas?: number }) =>
    req<ServiceWithKey>('/api/services', { method: 'POST', body: JSON.stringify(body) }),
  stopService: (id: string) => req<InferenceService>(`/api/services/${id}/stop`, { method: 'POST' }),
  startService: (id: string) => req<InferenceService>(`/api/services/${id}/start`, { method: 'POST' }),
  scaleService: (id: string, replicas: number) =>
    req<InferenceService>(`/api/services/${id}/replicas`, { method: 'PUT', body: JSON.stringify({ replicas }) }),
  rotateServiceKey: (id: string) => req<ServiceWithKey>(`/api/services/${id}/rotate-key`, { method: 'POST' }),
  deleteService: (id: string) => req<{ status: string }>(`/api/services/${id}`, { method: 'DELETE' }),
  serviceLogs: (id: string) => req<{ logs: string }>(`/api/services/${id}/logs`),
  servicePredict: (id: string, input: Record<string, string | number>) =>
    req<ServicePrediction>(`/api/services/${id}/predict`, { method: 'POST', body: JSON.stringify({ input }) }),
  pipelines: () => req<Pipeline[]>('/api/pipelines'),
  pipeline: (id: string) => req<Pipeline>(`/api/pipelines/${id}`),
  createPipeline: (body: Record<string, unknown>) =>
    req<Pipeline>('/api/pipelines', { method: 'POST', body: JSON.stringify(body) }),
  cancelPipeline: (id: string) =>
    req<Pipeline>(`/api/pipelines/${id}/cancel`, { method: 'POST' }),
}
