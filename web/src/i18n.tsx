import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Lang = 'zh' | 'en'

const dict = {
  zh: {
    tagline: 'Kubernetes 上的轻量 AI 训练',
    navSectionTrain: '训练',
    navSectionOps: '运维',
    connected: 'Connected',
    navRuns: '训练任务',
    navNew: '新建训练',
    navCompare: '对比',
    navPipelines: '流水线',
    navSettings: '设置',
    login: '登录',
    loggingIn: '登录中…',
    logout: '退出',
    themeToggle: '主题',
    themeSystem: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    loginDesc: '使用平台账号登录。集群凭证由管理员统一配置，你只需选择已授权的集群。',
    username: '用户名',
    password: '密码',
    usersAdmin: '用户管理',
    createUser: '创建用户',
    role: '角色',
    grantNs: '授权命名空间',
    addGrant: '添加授权',
    runsTitle: '训练任务',
    runsDesc: '提交训练 Job · 排障请走顶栏 / 行内 CiliKube 入口',
    newRunBtn: '新建训练',
    colName: '名称',
    colStatus: '状态',
    colTemplate: '模板',
    colNamespace: '命名空间',
    colCreated: '创建时间',
    colDuration: '耗时',
    emptyRuns: '还没有任务。请先在「设置」添加集群，再新建训练。',
    status_pending: '排队中',
    status_running: '运行中',
    status_succeeded: '成功',
    status_failed: '失败',
    status_timeout: '超时',
    status_cancelled: '已取消',
    cancel: '停止任务',
    cancelling: '停止中…',
    cancelTitle: '停止训练任务',
    cancelConfirm:
      '将立即删除集群中的 Job 与 Pod，训练进程会被终止。此操作不可恢复（与 Kubeflow Stop / delete_job 同类）。',
    deleteRecord: '删除记录',
    deleting: '删除中…',
    deleteTitle: '删除任务记录',
    deleteConfirm:
      '将永久删除平台中的任务记录，并尽量清理集群残留 Job。删除后无法从列表恢复。',
    deleteTypeHint: '请输入任务名称以确认删除：',
    confirmCancel: '取消',
    confirmOk: '确认停止',
    confirmDelete: '确认删除',
    rerun: '重新运行',
    rerunning: '提交中…',
    rerunTitle: '重新运行',
    rerunConfirm: '将用相同参数新建并提交一个训练 Job（类似 Kubeflow retry / clone）。',
    confirmRerun: '确认重跑',
    filterAll: '全部',
    filterActive: '进行中',
    filterDone: '已结束',
    searchPlaceholder: '搜索名称 / Job / 模板…',
    copyYaml: '复制 YAML',
    copied: '已复制',
    actions: '操作',
    metrics: '训练指标',
    artifacts: '产物',
    noMetrics: '暂无指标。模板请打印 metrics key=value 或写出 /output/metrics.json',
    noArtifacts: '暂无产物。任务成功后会从 Pod /output 采集小文件。',
    artifactsPending: '训练结束后会短暂保留 Pod 以采集 /output 产物…',
    artifactsSkipped: '采集窗口已过且无本地产物，可重新运行后再试。',
    download: '下载',
    resourceMon: '资源监控',
    resourceUnavailable: '集群未安装 metrics-server，仅展示训练指标（loss/acc 等）。',
    resourceLive: 'Pod 实时资源',
    resourceIdle: 'metrics-server 已就绪；Pod 运行中才有瞬时 CPU/内存。',
    resourcePending:
      'Pod 已在运行，正在等待 metrics-server 首次采集（约 15 秒）。下方暂显示集群节点负载。',
    resourceFinished: '任务已结束，无实时 Pod CPU/内存。',
    resourceFinishedHist: '任务已结束。下方为运行期间的历史资源曲线（已冻结，不再刷新）。',
    resourceFrozen: '历史已冻结',
    resourceChart: 'Pod 资源曲线',
    resourceChartHint: 'Prometheus 历史曲线；无 Prometheus 时用 metrics-server 轮询采样',
    resourceFromProm: '数据源：Prometheus',
    resourceFromMs: '数据源：metrics-server 采样',
    timeAxis: '时间 (s)',
    timeRelWall: '时长 {rel}s · {wall}',
    cpuMilli: 'cpu_m',
    memMi: 'memory_mi',
    clusterNodes: '集群节点负载',
    chartHint: '悬停查看各 epoch 数值',
    resourceHoverHint: '悬停查看时长与墙上时间',
    epochAxis: 'Epoch',
    compareTitle: '实验对比',
    compareDesc: '选择 2～4 个已结束任务，对比指标与规格（类似 MLflow / Kubeflow 实验对比）。',
    compareAction: '开始对比',
    pickRuns: '勾选要对比的任务',
    pipelinesTitle: '训练流水线',
    pipelinesDesc:
      '简单多步：预处理 → 训练。自动创建共享 PVC（挂载 /pipeline，产物在 /pipeline/output）。',
    newPipeline: '新建流水线',
    pipelineName: '流水线名称',
    createPipeline: '创建并启动',
    step: '步骤',
    pipelineRuns: '关联任务',
    pipelinePvc: '共享 PVC',
    newTitle: '新建训练',
    newDesc: '护栏：CPU ≤ 2 · 内存 ≤ 4Gi · GPU ≤ max_gpu · 超时 ≤ 2h',
    needCluster: '请先在「设置」中添加集群。',
    cluster: '集群',
    template: '模板',
    name: '名称',
    namespace: '命名空间',
    image: '镜像',
    command: '命令（JSON 数组）',
    args: '参数（JSON 数组）',
    cpu: 'CPU',
    memory: '内存',
    gpu: 'GPU 数量',
    gpuHint: '需要集群已装 NVIDIA device plugin；Kind/无 GPU 节点会被拒绝。',
    timeout: '超时（秒）',
    pvc: 'PVC 名称（可选）',
    submit: '提交训练 Job',
    submitting: '提交中…',
    backRuns: '← 训练任务',
    openCilikube: '在 CiliKube 中打开',
    cilikubePanelTitle: '在 CiliKube 中查看',
    cilikubePanelDesc: '训练仍在本页；点下列链接到集群控制台排障（Job / Pod / 事件）。',
    ckLinkJob: 'Job',
    ckLinkPod: 'Pod',
    ckLinkEvents: '事件',
    ckLinkPvc: 'PVC',
    ckLinkConsole: '控制台',
    cilikubeNavHint: '打开 CiliKube 集群控制台',
    cilikubeNotConfigured: '尚未配置 CiliKube 地址',
    goSettings: '前往设置',
    openConsole: '打开控制台',
    spec: '规格',
    events: '事件',
    logs: '日志',
    jobYaml: 'Job YAML',
    none: '（无）',
    loading: '加载中…',
    settingsTitle: '设置',
    settingsDesc: 'Direct kubeconfig 提交训练 · CiliKube 为集群排障入口',
    clusters: '集群',
    noClusters: '暂无集群 — 请在下方添加。',
    remove: '移除',
    ctxOptional: 'Context（可选）',
    kubePath: 'Kubeconfig 路径',
    kubePaste: '或粘贴 kubeconfig',
    addCluster: '添加集群',
    cilikubeTitle: 'CiliKube 集群控制台',
    cilikubeDesc:
      '填写 CiliKube 地址后，顶栏与训练详情会出现入口。训练 Job 仍由本平台用 kubeconfig 直接提交，不经 CiliKube 代理。',
    save: '保存',
    saved: '已保存',
    clusterAdded: '集群已添加',
    phase: 'Pod 阶段',
    reason: '原因',
  },
  en: {
    tagline: 'AI training on Kubernetes',
    navSectionTrain: 'Train',
    navSectionOps: 'Ops',
    connected: 'Connected',
    navRuns: 'Runs',
    navNew: 'New run',
    navCompare: 'Compare',
    navPipelines: 'Pipelines',
    navSettings: 'Settings',
    login: 'Sign in',
    loggingIn: 'Signing in…',
    logout: 'Sign out',
    themeToggle: 'Theme',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    loginDesc:
      'Sign in with a platform account. Cluster credentials stay on the server; you only pick granted clusters.',
    username: 'Username',
    password: 'Password',
    usersAdmin: 'Users',
    createUser: 'Create user',
    role: 'Role',
    grantNs: 'Grant namespace',
    addGrant: 'Add grant',
    runsTitle: 'Runs',
    runsDesc: 'Submit training Jobs · use CiliKube links for cluster troubleshooting',
    newRunBtn: 'New run',
    colName: 'Name',
    colStatus: 'Status',
    colTemplate: 'Template',
    colNamespace: 'Namespace',
    colCreated: 'Created',
    colDuration: 'Duration',
    emptyRuns: 'No runs yet. Add a cluster in Settings, then create a run.',
    status_pending: 'Pending',
    status_running: 'Running',
    status_succeeded: 'Succeeded',
    status_failed: 'Failed',
    status_timeout: 'Timeout',
    status_cancelled: 'Cancelled',
    cancel: 'Stop',
    cancelling: 'Stopping…',
    cancelTitle: 'Stop training run',
    cancelConfirm:
      'This deletes the Job and Pods immediately and kills training. Not reversible (Kubeflow-style stop / delete_job).',
    deleteRecord: 'Delete',
    deleting: 'Deleting…',
    deleteTitle: 'Delete run record',
    deleteConfirm:
      'Permanently removes this run from CiliTrain and best-effort cleans leftover Jobs. Cannot be undone.',
    deleteTypeHint: 'Type the run name to confirm:',
    confirmCancel: 'Cancel',
    confirmOk: 'Stop run',
    confirmDelete: 'Delete permanently',
    rerun: 'Rerun',
    rerunning: 'Submitting…',
    rerunTitle: 'Rerun training',
    rerunConfirm: 'Creates and submits a new Job with the same parameters (Kubeflow-style retry/clone).',
    confirmRerun: 'Rerun',
    filterAll: 'All',
    filterActive: 'Active',
    filterDone: 'Finished',
    searchPlaceholder: 'Search name / job / template…',
    copyYaml: 'Copy YAML',
    copied: 'Copied',
    actions: 'Actions',
    metrics: 'Metrics',
    artifacts: 'Artifacts',
    noMetrics: 'No metrics yet. Print metrics key=value or write /output/metrics.json',
    noArtifacts: 'No artifacts. Small files under Pod /output are collected after success.',
    artifactsPending: 'Pod is held briefly after training so /output can be collected…',
    artifactsSkipped: 'Harvest window missed and no local artifacts — try a rerun.',
    download: 'Download',
    resourceMon: 'Resources',
    resourceUnavailable: 'metrics-server not installed; showing training metrics only.',
    resourceLive: 'Pod live resources',
    resourceIdle: 'metrics-server ready; CPU/memory shown while the pod is Running.',
    resourcePending:
      'Pod is Running; waiting for the first metrics-server scrape (~15s). Showing cluster nodes meanwhile.',
    resourceFinished: 'Run finished — no live Pod CPU/memory.',
    resourceFinishedHist: 'Run finished. Charts below are frozen history from the run window.',
    resourceFrozen: 'History frozen',
    resourceChart: 'Pod resource chart',
    resourceChartHint: 'Prometheus history; falls back to metrics-server polling samples',
    resourceFromProm: 'Source: Prometheus',
    resourceFromMs: 'Source: metrics-server samples',
    timeAxis: 'Time (s)',
    timeRelWall: '{rel}s · {wall}',
    cpuMilli: 'cpu_m',
    memMi: 'memory_mi',
    clusterNodes: 'Cluster node load',
    chartHint: 'Hover to inspect epoch values',
    resourceHoverHint: 'Hover for duration + wall clock',
    epochAxis: 'Epoch',
    compareTitle: 'Compare runs',
    compareDesc: 'Pick 2–4 finished runs to compare metrics and specs (MLflow / Kubeflow style).',
    compareAction: 'Compare',
    pickRuns: 'Select runs to compare',
    pipelinesTitle: 'Pipelines',
    pipelinesDesc:
      'Simple multi-step: preprocess → train. Auto-creates a shared PVC (/pipeline → /pipeline/output).',
    newPipeline: 'New pipeline',
    pipelineName: 'Pipeline name',
    createPipeline: 'Create & start',
    step: 'Step',
    pipelineRuns: 'Linked runs',
    pipelinePvc: 'Shared PVC',
    newTitle: 'New run',
    newDesc: 'Guardrails: CPU ≤ 2 · memory ≤ 4Gi · GPU ≤ max_gpu · timeout ≤ 2h',
    needCluster: 'Add a cluster in Settings first.',
    cluster: 'Cluster',
    template: 'Template',
    name: 'Name',
    namespace: 'Namespace',
    image: 'Image',
    command: 'Command (JSON array)',
    args: 'Args (JSON array)',
    cpu: 'CPU',
    memory: 'Memory',
    gpu: 'GPU count',
    gpuHint: 'Requires NVIDIA device plugin on the cluster; Kind / no-GPU nodes are rejected.',
    timeout: 'Timeout (s)',
    pvc: 'PVC name (optional)',
    submit: 'Submit training Job',
    submitting: 'Submitting…',
    backRuns: '← Runs',
    openCilikube: 'Open in CiliKube',
    cilikubePanelTitle: 'View in CiliKube',
    cilikubePanelDesc: 'Stay here for training; use these links for cluster troubleshooting.',
    ckLinkJob: 'Job',
    ckLinkPod: 'Pod',
    ckLinkEvents: 'Events',
    ckLinkPvc: 'PVC',
    ckLinkConsole: 'Console',
    cilikubeNavHint: 'Open CiliKube cluster console',
    cilikubeNotConfigured: 'CiliKube URL not configured',
    goSettings: 'Go to Settings',
    openConsole: 'Open console',
    spec: 'Spec',
    events: 'Events',
    logs: 'Logs',
    jobYaml: 'Job YAML',
    none: '(none)',
    loading: 'Loading…',
    settingsTitle: 'Settings',
    settingsDesc: 'Direct kubeconfig for training submit · CiliKube as cluster console entry',
    clusters: 'Clusters',
    noClusters: 'No clusters — add one below.',
    remove: 'Remove',
    ctxOptional: 'Context (optional)',
    kubePath: 'Kubeconfig path',
    kubePaste: 'Or paste kubeconfig',
    addCluster: 'Add cluster',
    cilikubeTitle: 'CiliKube cluster console',
    cilikubeDesc:
      'Set the CiliKube base URL to show entry points in the header and run pages. Jobs are still submitted via kubeconfig — not proxied through CiliKube.',
    save: 'Save',
    saved: 'Settings saved',
    clusterAdded: 'Cluster added',
    phase: 'Pod phase',
    reason: 'Reason',
  },
} as const

type Key = keyof (typeof dict)['zh']

type I18nCtx = {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: Key) => string
  statusLabel: (status: string) => string
}

const Ctx = createContext<I18nCtx | null>(null)

function detectLang(): Lang {
  const saved = localStorage.getItem('cilitrain_lang')
  if (saved === 'zh' || saved === 'en') return saved
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'zh'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang)
  const setLang = useCallback((l: Lang) => {
    localStorage.setItem('cilitrain_lang', l)
    setLangState(l)
  }, [])
  const t = useCallback((key: Key) => dict[lang][key] || dict.en[key] || key, [lang])
  const statusLabel = useCallback(
    (status: string) => {
      const k = `status_${status}` as Key
      return dict[lang][k] || status
    },
    [lang],
  )
  const value = useMemo(() => ({ lang, setLang, t, statusLabel }), [lang, setLang, t, statusLabel])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n() {
  const v = useContext(Ctx)
  if (!v) throw new Error('I18nProvider missing')
  return v
}

export function formatDuration(sec?: number | null) {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Parse API datetime: treat naive ISO as UTC (legacy responses without Z). */
export function parseApiDate(value: string | number | Date): Date {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1))
  const s = String(value).trim()
  // "2026-08-03T15:11:08.597423" → UTC
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)) {
    return new Date(s + 'Z')
  }
  return new Date(s)
}

/** Display API UTC time in the browser's local timezone. */
export function formatLocalDateTime(value?: string | number | Date | null): string {
  if (value == null || value === '') return '—'
  const d = parseApiDate(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}
