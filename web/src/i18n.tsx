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
    navRuns: '训练任务',
    navNew: '新建训练',
    navSettings: '设置',
    runsTitle: '训练任务',
    runsDesc: '提交 CPU 训练 Job · 集群真相仍在 CiliKube',
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
    newTitle: '新建训练',
    newDesc: '护栏：CPU ≤ 2 · 内存 ≤ 4Gi · 超时 ≤ 2h',
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
    timeout: '超时（秒）',
    pvc: 'PVC 名称（可选）',
    submit: '提交训练 Job',
    submitting: '提交中…',
    backRuns: '← 训练任务',
    openCilikube: '在 CiliKube 中打开',
    spec: '规格',
    events: '事件',
    logs: '日志',
    jobYaml: 'Job YAML',
    none: '（无）',
    loading: '加载中…',
    settingsTitle: '设置',
    settingsDesc: 'Direct kubeconfig 提交 Job · CiliKube 仅可选深链',
    clusters: '集群',
    noClusters: '暂无集群 — 请在下方添加。',
    remove: '移除',
    ctxOptional: 'Context（可选）',
    kubePath: 'Kubeconfig 路径',
    kubePaste: '或粘贴 kubeconfig',
    addCluster: '添加集群',
    cilikubeTitle: 'CiliKube 深链',
    cilikubeDesc: '可选。仅生成「在 CiliKube 中打开」链接，v0.1 不经 CiliKube 代理提交。',
    save: '保存',
    saved: '已保存',
    clusterAdded: '集群已添加',
    phase: 'Pod 阶段',
    reason: '原因',
  },
  en: {
    tagline: 'AI training on Kubernetes',
    navRuns: 'Runs',
    navNew: 'New run',
    navSettings: 'Settings',
    runsTitle: 'Runs',
    runsDesc: 'Submit CPU training Jobs · cluster truth stays in CiliKube',
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
    newTitle: 'New run',
    newDesc: 'Guardrails: CPU ≤ 2 · memory ≤ 4Gi · timeout ≤ 2h',
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
    timeout: 'Timeout (s)',
    pvc: 'PVC name (optional)',
    submit: 'Submit training Job',
    submitting: 'Submitting…',
    backRuns: '← Runs',
    openCilikube: 'Open in CiliKube',
    spec: 'Spec',
    events: 'Events',
    logs: 'Logs',
    jobYaml: 'Job YAML',
    none: '(none)',
    loading: 'Loading…',
    settingsTitle: 'Settings',
    settingsDesc: 'Direct kubeconfig for Job submit · optional CiliKube deep-link',
    clusters: 'Clusters',
    noClusters: 'No clusters — add one below.',
    remove: 'Remove',
    ctxOptional: 'Context (optional)',
    kubePath: 'Kubeconfig path',
    kubePaste: 'Or paste kubeconfig',
    addCluster: 'Add cluster',
    cilikubeTitle: 'CiliKube deep-link',
    cilikubeDesc: 'Optional. Only builds “Open in CiliKube” URLs — no proxy submit in v0.1.',
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
