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
  events: string[]
}

export type MetricsView = {
  run_id: string
  name?: string
  status?: string
  summary: Record<string, number>
  series: Record<string, number>[]
  chart_keys: string[]
  artifacts: { path: string; size: number }[]
  resource?: {
    available: boolean
    message?: string
    cpu?: string
    memory?: string
    pod_name?: string
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
  error_message?: string | null
  created_at: string
  updated_at: string
  finished_at?: string | null
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
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
  templates: () => req<Template[]>('/api/templates'),
  clusters: () => req<Cluster[]>('/api/clusters'),
  createCluster: (body: Record<string, unknown>) =>
    req<Cluster>('/api/clusters', { method: 'POST', body: JSON.stringify(body) }),
  deleteCluster: (id: string) => req<{ status: string }>(`/api/clusters/${id}`, { method: 'DELETE' }),
  settings: () => req<{ cilikube_base_url?: string | null }>('/api/settings'),
  putSettings: (cilikube_base_url: string | null) =>
    req<{ cilikube_base_url?: string | null }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ cilikube_base_url }),
    }),
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
