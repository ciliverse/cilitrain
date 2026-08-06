export type Cluster = {
  id: string
  name: string
  context?: string | null
  kubeconfig_path?: string | null
  has_kubeconfig_content: boolean
  cilikube_base_url?: string | null
  created_at: string
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
  created_at: string
  updated_at: string
  finished_at?: string | null
  cilikube_url?: string | null
  cilikube_links?: CiliKubeLinks
  events: string[]
}

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
  createCluster: (body: Record<string, unknown>) =>
    req<Cluster>('/api/clusters', { method: 'POST', body: JSON.stringify(body) }),
  deleteCluster: (id: string) => req<{ status: string }>(`/api/clusters/${id}`, { method: 'DELETE' }),
  settings: () =>
    req<{ cilikube_base_url?: string | null; cilikube_configured?: boolean; max_gpu?: number }>(
      '/api/settings',
    ),
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
  cancelRun: (id: string) => req<Run>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  rerunRun: (id: string) => req<Run>(`/api/runs/${id}/rerun`, { method: 'POST' }),
  deleteRun: (id: string) => req<{ status: string }>(`/api/runs/${id}`, { method: 'DELETE' }),
  logs: (id: string) => req<{ pod_name?: string | null; logs: string }>(`/api/runs/${id}/logs`),
  metrics: (id: string) => req<MetricsView>(`/api/runs/${id}/metrics`),
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
  pipelines: () => req<Pipeline[]>('/api/pipelines'),
  pipeline: (id: string) => req<Pipeline>(`/api/pipelines/${id}`),
  createPipeline: (body: Record<string, unknown>) =>
    req<Pipeline>('/api/pipelines', { method: 'POST', body: JSON.stringify(body) }),
  cancelPipeline: (id: string) =>
    req<Pipeline>(`/api/pipelines/${id}/cancel`, { method: 'POST' }),
}
