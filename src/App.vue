<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  NButton, NCard, NConfigProvider, NDropdown, NEmpty, NIcon, NInput, NInputNumber,
  NModal, NPopconfirm, NProgress, NSelect, NSpin, NSwitch, NTag,
  zhCN, type GlobalThemeOverrides,
} from 'naive-ui'
import PerfectScrollbar from 'perfect-scrollbar'
import 'perfect-scrollbar/css/perfect-scrollbar.css'
import {
  AddOutline, ArrowBackOutline, ArrowForwardOutline, BookmarkOutline, BookmarksOutline,
  ChevronBackOutline, ChevronForwardOutline, CloseOutline, CogOutline, ContractOutline,
  CloudDownloadOutline, CloudUploadOutline, CopyOutline, CreateOutline, EllipsisHorizontal, ExpandOutline, FolderOpenOutline,
  DocumentTextOutline, GlobeOutline, InformationCircleOutline, LayersOutline, MenuOutline, RefreshOutline,
  CheckmarkCircleOutline, OpenOutline, RemoveOutline, RocketOutline, SaveOutline, SearchOutline, Star, StarOutline, StopOutline,
  TrashOutline, ExtensionPuzzleOutline, ChatbubbleEllipsesOutline, SyncOutline, WarningOutline,
} from '@vicons/ionicons5'
import type {
  AppState, BrowserSession, BrowserTab, Favorite, FavoriteFolder, HardwareClass, InstalledPlugin,
  MemoryPressureLevel, PerformanceTier, PluginEngineState, PluginSettingSchema, UpdateStatus,
} from './types'

type ModalKind = '' | 'session' | 'favorites' | 'plugins' | 'settings' | 'recycle' | 'transfer' | 'update' | 'close'
type HeaderItem = { id: string; kind: 'browser'; tab: BrowserTab } | { id: '__memo__'; kind: 'memo' }

const api = window.starbrowser
const state = ref<AppState | null>(null)
const address = ref('')
const modalKind = ref<ModalKind>('')
const editingSessionId = ref('')
const toast = ref('')
const toastTimer = ref<number | null>(null)
const isMaximized = ref(false)
const tabDragging = ref(false)
const favoriteDragging = ref(false)
const tabList = ref<HTMLElement | null>(null)
const favoriteBar = ref<HTMLElement | null>(null)
const sessionList = ref<HTMLElement | null>(null)
const liveTabIds = ref<string[]>([])
const recentTabIds = ref<string[]>([])
const recentSessionIds = ref<string[]>([])
const readyTabIds = ref<string[]>([])
const machineProfile = ref<{ tier: PerformanceTier; hardwareClass: HardwareClass; hardwareScore: number; totalMemoryGB: number; logicalCpuCount: number; averageCpuMHz: number }>({ tier: 'medium', hardwareClass: 'balanced', hardwareScore: 2, totalMemoryGB: 0, logicalCpuCount: 0, averageCpuMHz: 0 })
const memoryStatus = ref<{ level: MemoryPressureLevel; freeMemoryGB: number; usedPercent: number; appWorkingSetMB: number }>({ level: 'normal', freeMemoryGB: 0, usedPercent: 0, appWorkingSetMB: 0 })
const performanceAdvice = ref<{ recommended: HardwareClass; reason: string } | null>(null)
const updateInfo = ref<UpdateStatus>({ phase: 'idle', currentVersion: '', progress: 0, transferred: 0, total: 0, speed: 0, error: '', manual: false, candidate: null })
const pluginState = ref<PluginEngineState>({ catalog: [], installed: [], results: {} })
const pluginCenterTab = ref<'all' | 'installed'>('all')
const pluginSettingsId = ref('')
const pluginConfigDraft = ref<Record<string, string | number | boolean>>({})
const pluginCenterBusy = ref('')
const deletePluginConfig = ref(false)
const logoUrl = new URL('../assets/starbrowser.ico', import.meta.url).href
let maintenanceTimer: number | null = null
let performanceMonitorTimer: number | null = null
let retentionTrimTimer: number | null = null
let sessionWarmupTimer: number | null = null
let browserPersistTimer: number | null = null
let warmingSessionId = ''
let poorPerformanceSamples = 0
let adviceDismissedUntil = 0
let sessionScrollbar: PerfectScrollbar | null = null
let trustedTimeBase = 0
let trustedPerformanceBase = 0
let lastPerformanceSignature = ''
const liveInitialUrls = new Map<string, string>()
const mainFrameNavigationCounts = new Map<string, number>()

const tabDrag = reactive({
  id: '',
  pointerId: -1,
  startX: 0,
  offsetX: 0,
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  moved: false,
})

const favoriteDrag = reactive({
  id: '', pointerId: -1, startX: 0, offsetX: 0, left: 0, top: 0, width: 0, height: 0, moved: false,
})

const sessionDraft = reactive({ name: '', recycleMode: 'never', customRecycleDays: null as number | null })
const settingsDraft = reactive<{
  closeBehavior: 'ask' | 'tray' | 'exit'
  maximizeBehavior: 'maximize' | 'fullscreen'
  performanceTier: HardwareClass
}>({ closeBehavior: 'ask', maximizeBehavior: 'maximize', performanceTier: 'balanced' })
const favoriteDraft = reactive({ id: '', title: '', url: '', folderId: '' })
const newFolderName = ref('')
const editingFolderId = ref('')
const favoriteViewFolderId = ref('')
const draggedFavoriteId = ref('')
const draggedFolderId = ref('')
const rememberClose = ref(false)
const clockNow = ref(0)
const transferMode = ref<'export' | 'import'>('export')
const transferSessionId = ref('')
const transferDraft = reactive({ password: '', confirmation: '', busy: false })
const recycleOptions = [
  { label: '永不回收', value: 'never' },
  { label: '1 天', value: '1' },
  { label: '7 天', value: '7' },
  { label: '15 天', value: '15' },
  { label: '30 天', value: '30' },
  { label: '自定义', value: 'custom' },
]

type PerformancePolicy = {
  maxLiveSessions: number
  maxLiveTabs: number
  maxTabsPerSession: number
  activeFrameRate: number
  backgroundFrameRate: number
  effects: string
  hoverWarmupMs: number
  releaseDelayMs: number
  fullHoverWarmup: boolean
}

const performancePolicies: Record<HardwareClass, PerformancePolicy> = {
  'ultra-low': { maxLiveSessions: 1, maxLiveTabs: 1, maxTabsPerSession: 1, activeFrameRate: 24, backgroundFrameRate: 1, effects: '极简', hoverWarmupMs: 0, releaseDelayMs: 350, fullHoverWarmup: false },
  low: { maxLiveSessions: 1, maxLiveTabs: 2, maxTabsPerSession: 2, activeFrameRate: 30, backgroundFrameRate: 3, effects: '精简', hoverWarmupMs: 0, releaseDelayMs: 1_200, fullHoverWarmup: false },
  balanced: { maxLiveSessions: 3, maxLiveTabs: 10, maxTabsPerSession: 5, activeFrameRate: 50, backgroundFrameRate: 12, effects: '平衡', hoverWarmupMs: 350, releaseDelayMs: 20_000, fullHoverWarmup: true },
  high: { maxLiveSessions: 6, maxLiveTabs: 24, maxTabsPerSession: 8, activeFrameRate: 60, backgroundFrameRate: 24, effects: '完整', hoverWarmupMs: 160, releaseDelayMs: 90_000, fullHoverWarmup: true },
  'ultra-high': { maxLiveSessions: 12, maxLiveTabs: 48, maxTabsPerSession: 12, activeFrameRate: 60, backgroundFrameRate: 30, effects: '完整', hoverWarmupMs: 80, releaseDelayMs: 180_000, fullHoverWarmup: true },
}

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#635bff',
    primaryColorHover: '#756eff',
    primaryColorPressed: '#5148e0',
    primaryColorSuppl: '#635bff',
    borderRadius: '11px',
    borderColor: '#e5e7ee',
    textColorBase: '#202127',
    fontFamily: '"Segoe UI Variable", "Microsoft YaHei UI", "Segoe UI", sans-serif',
  },
  Button: {
    borderRadiusSmall: '9px',
    borderRadiusMedium: '11px',
    borderRadiusLarge: '12px',
    heightMedium: '36px',
    fontWeightStrong: '600',
  },
  Card: { borderRadius: '16px' },
  Dropdown: { borderRadius: '12px', padding: '6px' },
  Input: { borderRadius: '11px', heightMedium: '38px' },
  Select: { peers: { InternalSelection: { borderRadius: '11px', heightMedium: '38px' } } },
  DatePicker: { itemBorderRadius: '8px', panelBorderRadius: '14px' },
  Modal: { borderRadius: '18px', boxShadow: '0 20px 60px rgba(27, 25, 55, .18)' },
}

const activeSession = computed(() => {
  if (!state.value) return null
  return state.value.sessions.find((item) => item.id === state.value!.activeSessionId) || state.value.sessions[0] || null
})
const activeTab = computed(() => activeSession.value?.tabs.find((item) => item.id === activeSession.value?.activeTabId) || activeSession.value?.tabs[0] || null)
const browserVisible = computed(() => Boolean(activeSession.value && !activeSession.value.memoActive))
const activePageReady = computed(() => Boolean(activeTab.value && readyTabIds.value.includes(activeTab.value.id)))
const sidebarCollapsed = computed(() => Boolean(state.value?.settings.sidebarCollapsed))
const selectedPerformanceTier = computed<HardwareClass>(() => state.value?.settings.performanceTier || machineProfile.value.hardwareClass)
const effectivePerformanceTier = computed<PerformanceTier>(() => selectedPerformanceTier.value === 'ultra-low' || selectedPerformanceTier.value === 'low'
  ? 'low'
  : selectedPerformanceTier.value === 'balanced'
    ? 'medium'
    : 'high')
const currentPerformancePolicy = computed<PerformancePolicy>(() => performancePolicies[selectedPerformanceTier.value])
const draftPerformanceTier = computed<PerformanceTier>(() => settingsDraft.performanceTier === 'ultra-low' || settingsDraft.performanceTier === 'low'
  ? 'low'
  : settingsDraft.performanceTier === 'balanced'
    ? 'medium'
    : 'high')
const draftPerformancePolicy = computed<PerformancePolicy>(() => performancePolicies[settingsDraft.performanceTier])
const performanceOptions = [
  { label: '超低配 · 1 会话 / 1 标签', value: 'ultra-low' },
  { label: '低配 · 1 会话 / 2 标签', value: 'low' },
  { label: '均衡 · 3 会话 / 10 标签', value: 'balanced' },
  { label: '高配 · 6 会话 / 24 标签', value: 'high' },
  { label: '超高配 · 12 会话 / 48 标签', value: 'ultra-high' },
]
const hardwareClassOrder: HardwareClass[] = ['ultra-low', 'low', 'balanced', 'high', 'ultra-high']
const hardwareClassLabels: Record<HardwareClass, string> = { 'ultra-low': '超低配', low: '低配', balanced: '均衡', high: '高配', 'ultra-high': '超高配' }
const modalTitle = computed(() => {
  const titles: Record<Exclude<ModalKind, ''>, string> = {
    session: editingSessionId.value ? '编辑会话' : '新建隔离会话',
    favorites: '收藏夹', plugins: '插件中心', settings: '设置', recycle: '回收站', transfer: transferMode.value === 'export' ? '导出加密会话' : '导入加密会话', update: '软件更新', close: '关闭 StarBrowser',
  }
  return modalKind.value ? titles[modalKind.value] : ''
})
const modalShown = computed({
  get: () => Boolean(modalKind.value),
  set: (visible: boolean) => { if (!visible) modalKind.value = '' },
})
const favoriteActive = computed(() => Boolean(activeTab.value && state.value?.favorites.some((item) => item.url === activeTab.value!.url)))
const rootFavorites = computed(() => state.value?.favorites || [])
const selectedPluginSettings = computed(() => pluginState.value.installed.find((item) => item.id === pluginSettingsId.value) || null)
const headerItems = computed<HeaderItem[]>(() => {
  const session = activeSession.value
  if (!session) return []
  const items: HeaderItem[] = session.tabs.map((tab) => ({ id: tab.id, kind: 'browser', tab }))
  if (session.memoTabVisible) items.splice(Math.max(0, Math.min(session.memoTabIndex, items.length)), 0, { id: '__memo__', kind: 'memo' })
  return items
})
const liveTabs = computed(() => {
  if (!state.value) return []
  const result: Array<{ tab: BrowserTab; session: BrowserSession; initialUrl: string }> = []
  for (const tabId of liveTabIds.value) {
    for (const session of state.value.sessions) {
      const tab = session.tabs.find((item) => item.id === tabId)
      if (tab) {
        result.push({ tab, session, initialUrl: liveInitialUrls.get(tab.id) || tab.url })
        break
      }
    }
  }
  return result
})
const draggedHeaderItem = computed(() => headerItems.value.find((item) => item.id === tabDrag.id) || null)
const draggedFavorite = computed(() => state.value?.favorites.find((item) => item.id === favoriteDrag.id) || null)
const draggedTabStyle = computed(() => ({
  left: `${tabDrag.left}px`,
  top: `${tabDrag.top}px`,
  width: `${tabDrag.width}px`,
  height: `${tabDrag.height}px`,
}))
const draggedFavoriteStyle = computed(() => ({
  left: `${favoriteDrag.left}px`, top: `${favoriteDrag.top}px`, width: `${favoriteDrag.width}px`, height: `${favoriteDrag.height}px`,
}))

function uid() {
  return crypto.randomUUID().replaceAll('-', '')
}

function createTab(url = 'https://www.bing.com/'): BrowserTab {
  return { id: uid(), title: '新标签页', url, favicon: '', loading: false, canGoBack: false, canGoForward: false, createdAt: new Date().toISOString() }
}

function createSession(name = '新会话'): BrowserSession {
  const tab = createTab()
  return {
    id: uid(), profileName: `session_${uid()}`, name, memo: '', memoTabVisible: false, memoTabIndex: 1,
    memoActive: false, createdAt: new Date().toISOString(), expiresAt: null,
    recycleAfterDays: null, recycleDaysRemaining: null, recycleLastCheckedDate: null,
    activeTabId: tab.id, tabs: [tab],
  }
}

function cloneState() {
  return JSON.parse(JSON.stringify(state.value)) as AppState
}

function persist() {
  if (state.value) api.state.update(cloneState())
}

function flushBrowserPersist() {
  if (browserPersistTimer) window.clearTimeout(browserPersistTimer)
  browserPersistTimer = null
  persist()
}

function scheduleBrowserPersist() {
  if (browserPersistTimer) window.clearTimeout(browserPersistTimer)
  browserPersistTimer = window.setTimeout(flushBrowserPersist, 180)
}

function notify(message: string) {
  toast.value = message
  if (toastTimer.value) window.clearTimeout(toastTimer.value)
  toastTimer.value = window.setTimeout(() => { toast.value = '' }, 2800)
}

function formatTime(value: string | null | undefined) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function formatDate(value: string | null | undefined) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

function releaseDelayLabel(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds} 毫秒`
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} 秒`
  return `${Math.round(milliseconds / 60_000)} 分钟`
}

function recommendedLowerTier(current: HardwareClass, severity: MemoryPressureLevel | 'slow-ui') {
  const index = hardwareClassOrder.indexOf(current)
  const steps = severity === 'critical' ? 2 : 1
  return hardwareClassOrder[Math.max(0, index - steps)]
}

function remainingDays(session: BrowserSession) {
  if (session.recycleDaysRemaining === null || session.recycleDaysRemaining === undefined) return null
  return Number.isFinite(Number(session.recycleDaysRemaining)) ? Math.max(0, Math.floor(Number(session.recycleDaysRemaining))) : null
}

function partitionFor(session: BrowserSession) {
  return `persist:starbrowser_${session.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function webviewFor(tabId: string) {
  return document.querySelector<StarBrowserWebviewElement>(`webview[data-tab-id="${CSS.escape(tabId)}"]`)
}

function guestIdFor(tabId: string) {
  try {
    return webviewFor(tabId)?.getWebContentsId() || 0
  } catch {
    return 0
  }
}

async function waitForGuestId(tabId: string, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const id = guestIdFor(tabId)
    if (id) return id
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return 0
}

function removeLiveTab(tabId: string) {
  liveTabIds.value = liveTabIds.value.filter((id) => id !== tabId)
  recentTabIds.value = recentTabIds.value.filter((id) => id !== tabId)
  readyTabIds.value = readyTabIds.value.filter((id) => id !== tabId)
  liveInitialUrls.delete(tabId)
  mainFrameNavigationCounts.delete(tabId)
}

function touchRecent(list: string[], id: string) {
  const index = list.indexOf(id)
  if (index >= 0) list.splice(index, 1)
  list.unshift(id)
}

function runtimeLiveBudget(policy = currentPerformancePolicy.value) {
  if (memoryStatus.value.level === 'critical') return 1
  if (memoryStatus.value.level === 'constrained') return Math.max(1, Math.ceil(policy.maxLiveTabs * .5))
  return policy.maxLiveTabs
}

function runtimeSessionBudget(policy = currentPerformancePolicy.value) {
  if (memoryStatus.value.level === 'critical') return 1
  if (memoryStatus.value.level === 'constrained') return Math.max(1, Math.ceil(policy.maxLiveSessions * .5))
  return policy.maxLiveSessions
}

function runtimePerSessionBudget(policy = currentPerformancePolicy.value) {
  if (memoryStatus.value.level === 'critical') return 1
  if (memoryStatus.value.level === 'constrained') return Math.max(1, Math.ceil(policy.maxTabsPerSession * .5))
  return policy.maxTabsPerSession
}

function trimLiveTabs() {
  if (!state.value) return
  const policy = currentPerformancePolicy.value
  const sessionByTab = new Map<string, BrowserSession>()
  const validSessionIds = new Set(state.value.sessions.map((session) => session.id))
  for (const session of state.value.sessions) for (const tab of session.tabs) sessionByTab.set(tab.id, session)
  recentSessionIds.value = recentSessionIds.value.filter((id, index, values) => validSessionIds.has(id) && values.indexOf(id) === index)
  recentTabIds.value = recentTabIds.value.filter((id, index, values) => sessionByTab.has(id) && values.indexOf(id) === index)
  if (activeSession.value) touchRecent(recentSessionIds.value, activeSession.value.id)

  const maxLiveTabs = runtimeLiveBudget(policy)
  const maxTabsPerSession = runtimePerSessionBudget(policy)
  const allowedSessions = new Set(recentSessionIds.value.slice(0, runtimeSessionBudget(policy)))
  const liveSet = new Set(liveTabIds.value)
  const priority = [activeTab.value?.id || '', ...recentTabIds.value, ...liveTabIds.value].filter(Boolean)
  const keep: string[] = []
  const perSession = new Map<string, number>()
  for (const tabId of priority) {
    if (keep.includes(tabId) || !liveSet.has(tabId)) continue
    const owner = sessionByTab.get(tabId)
    if (!owner || !allowedSessions.has(owner.id)) continue
    const count = perSession.get(owner.id) || 0
    if (count >= maxTabsPerSession || keep.length >= maxLiveTabs) continue
    keep.push(tabId)
    perSession.set(owner.id, count + 1)
  }
  const removed = liveTabIds.value.filter((tabId) => !keep.includes(tabId))
  for (const tabId of removed) {
    liveInitialUrls.delete(tabId)
    mainFrameNavigationCounts.delete(tabId)
  }
  if (removed.length) {
    const removedSet = new Set(removed)
    readyTabIds.value = readyTabIds.value.filter((tabId) => !removedSet.has(tabId))
  }
  liveTabIds.value = keep
}

function scheduleRetentionTrim(delay = currentPerformancePolicy.value.releaseDelayMs) {
  if (retentionTrimTimer) window.clearTimeout(retentionTrimTimer)
  retentionTrimTimer = window.setTimeout(() => {
    retentionTrimTimer = null
    trimLiveTabs()
    void syncGuestPerformance()
  }, Math.max(0, delay))
}

async function syncGuestPerformance() {
  await nextTick()
  const guestIds = liveTabIds.value.map(guestIdFor).filter((id) => id > 0)
  const policy = currentPerformancePolicy.value
  const activeGuestId = activeTab.value ? guestIdFor(activeTab.value.id) : 0
  const signature = `${activeGuestId}|${guestIds.join(',')}|${policy.activeFrameRate}|${policy.backgroundFrameRate}`
  if (signature === lastPerformanceSignature) return
  lastPerformanceSignature = signature
  api.browser.applyPerformance({
    activeGuestId,
    guestIds,
    activeFrameRate: policy.activeFrameRate,
    backgroundFrameRate: policy.backgroundFrameRate,
  })
}

function applyPerformanceEnvironment(immediate = true) {
  if (!state.value) return
  if (immediate) trimLiveTabs()
  else scheduleRetentionTrim()
  document.body.classList.remove('performance-low-mode', 'performance-medium-mode', 'performance-high-mode')
  document.body.classList.add(`performance-${effectivePerformanceTier.value}-mode`)
  void syncGuestPerformance()
}

function ensureLiveTab(tab: BrowserTab, session = activeSession.value) {
  if (!liveTabIds.value.includes(tab.id)) {
    if (liveTabIds.value.length >= runtimeLiveBudget() + 2) trimLiveTabs()
    liveInitialUrls.set(tab.id, tab.url)
    liveTabIds.value.push(tab.id)
    readyTabIds.value = readyTabIds.value.filter((id) => id !== tab.id)
  }
  touchRecent(recentTabIds.value, tab.id)
  if (session) touchRecent(recentSessionIds.value, session.id)
  scheduleRetentionTrim()
}

function releasePointerButtonFocus(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('button')
  if (!button || button.disabled) return
  window.setTimeout(() => {
    if (document.activeElement === button) button.blur()
  }, 0)
}

function scheduleSessionWarmup(session: BrowserSession) {
  if (session.id === activeSession.value?.id) return
  if (sessionWarmupTimer) window.clearTimeout(sessionWarmupTimer)
  warmingSessionId = session.id
  const tab = session.tabs.find((item) => item.id === session.activeTabId) || session.tabs[0]
  if (!tab) return
  void api.browser.preconnect(session.id, tab.url)
  const policy = currentPerformancePolicy.value
  if (!policy.fullHoverWarmup) return
  sessionWarmupTimer = window.setTimeout(() => {
    sessionWarmupTimer = null
    if (warmingSessionId !== session.id || !state.value?.sessions.some((item) => item.id === session.id)) return
    ensureLiveTab(tab, session)
    if (retentionTrimTimer) window.clearTimeout(retentionTrimTimer)
    retentionTrimTimer = null
  }, policy.hoverWarmupMs)
}

function cancelSessionWarmup(sessionId: string) {
  if (warmingSessionId !== sessionId) return
  warmingSessionId = ''
  if (sessionWarmupTimer) window.clearTimeout(sessionWarmupTimer)
  sessionWarmupTimer = null
  scheduleRetentionTrim(120)
}

async function refreshMemoryStatus() {
  const probeStarted = performance.now()
  await new Promise((resolve) => window.setTimeout(resolve, 120))
  const eventLoopLag = Math.max(0, performance.now() - probeStarted - 120)
  const next = await api.system.memoryStatus()
  const previousLevel = memoryStatus.value.level
  memoryStatus.value = next
  if (next.level !== 'normal' && next.level !== previousLevel) {
    trimLiveTabs()
    void syncGuestPerformance()
  }
  if (document.hidden || Date.now() < adviceDismissedUntil) return
  const severity: MemoryPressureLevel | 'slow-ui' = next.level !== 'normal' ? next.level : eventLoopLag >= 180 ? 'slow-ui' : 'normal'
  if (severity === 'normal') {
    poorPerformanceSamples = Math.max(0, poorPerformanceSamples - 1)
    return
  }
  poorPerformanceSamples += severity === 'critical' ? 2 : 1
  if (poorPerformanceSamples < 2) return
  const current = selectedPerformanceTier.value
  const recommended = recommendedLowerTier(current, severity)
  if (recommended === current) return
  performanceAdvice.value = {
    recommended,
    reason: severity === 'slow-ui'
      ? '检测到主界面持续响应偏慢'
      : `检测到系统内存持续紧张（可用 ${next.freeMemoryGB} GB）`,
  }
  poorPerformanceSamples = 0
}

function applyPerformanceRecommendation() {
  if (!state.value || !performanceAdvice.value) return
  state.value.settings.performanceTier = performanceAdvice.value.recommended
  state.value.settings.performanceSelectionSource = 'manual'
  performanceAdvice.value = null
  persist()
  applyPerformanceEnvironment(true)
  notify(`已固定切换为${hardwareClassLabels[state.value.settings.performanceTier]}档`)
}

function dismissPerformanceAdvice() {
  performanceAdvice.value = null
  adviceDismissedUntil = Date.now() + 30 * 60_000
}

async function activateTab(tab: BrowserTab) {
  const session = activeSession.value
  if (!session) return
  session.memoActive = false
  session.activeTabId = tab.id
  address.value = tab.url
  ensureLiveTab(tab, session)
  persist()
  await nextTick()
  webviewFor(tab.id)?.focus()
  void syncGuestPerformance()
}

async function activateSession(session: BrowserSession) {
  if (!state.value) return
  if (warmingSessionId === session.id) {
    warmingSessionId = ''
    if (sessionWarmupTimer) window.clearTimeout(sessionWarmupTimer)
    sessionWarmupTimer = null
  }
  state.value.activeSessionId = session.id
  touchRecent(recentSessionIds.value, session.id)
  await nextTick()
  if (!session.memoActive) {
    const tab = session.tabs.find((item) => item.id === session.activeTabId) || session.tabs[0]
    if (tab) await activateTab(tab)
  } else {
    persist()
    void syncGuestPerformance()
  }
}

function openExportSession(session: BrowserSession) {
  transferMode.value = 'export'
  transferSessionId.value = session.id
  Object.assign(transferDraft, { password: '', confirmation: '', busy: false })
  void openModal('transfer')
}

function openImportSession() {
  transferMode.value = 'import'
  transferSessionId.value = ''
  Object.assign(transferDraft, { password: '', confirmation: '', busy: false })
  void openModal('transfer')
}

async function submitSessionTransfer() {
  if (transferDraft.busy) return
  if (transferDraft.password.length < 8) {
    notify('密码至少需要 8 个字符')
    return
  }
  if (transferMode.value === 'export' && transferDraft.password !== transferDraft.confirmation) {
    notify('两次输入的密码不一致')
    return
  }
  transferDraft.busy = true
  try {
    if (transferMode.value === 'export') {
      const result = await api.browser.exportSession(transferSessionId.value, transferDraft.password)
      if (result.canceled) return
      if (!result.ok) throw new Error(result.error || '导出失败')
      closeModal()
      notify(`会话已按加密格式 v${result.stats?.formatVersion || 1} 导出`)
      return
    }
    const result = await api.browser.importSession(transferDraft.password)
    if (result.canceled) return
    if (!result.ok || !result.session || !state.value) throw new Error(result.error || '导入失败')
    state.value.sessions.unshift(result.session)
    state.value.activeSessionId = result.session.id
    persist()
    closeModal()
    await activateSession(result.session)
    notify(`会话已导入：${result.stats?.cookieCount || 0} 个 Cookie`)
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  } finally {
    transferDraft.busy = false
  }
}

async function newTab(url = 'https://www.bing.com/') {
  const session = activeSession.value
  if (!session) return
  const tab = createTab(url)
  session.tabs.push(tab)
  await activateTab(tab)
}

async function closeTab(tab: BrowserTab) {
  const session = activeSession.value
  if (!session) return
  const index = session.tabs.findIndex((item) => item.id === tab.id)
  removeLiveTab(tab.id)
  session.tabs.splice(index, 1)
  if (!session.tabs.length) session.tabs.push(createTab())
  const next = session.tabs[Math.max(0, Math.min(index - 1, session.tabs.length - 1))]
  persist()
  await activateTab(next)
}

function moveTabToIndex(fromIndex: number, toIndex: number) {
  const tabs = activeSession.value?.tabs
  if (!tabs || fromIndex === toIndex || fromIndex < 0 || fromIndex >= tabs.length) return false
  const target = Math.max(0, Math.min(toIndex, tabs.length - 1))
  const [tab] = tabs.splice(fromIndex, 1)
  tabs.splice(target, 0, tab)
  return true
}

function targetTabIndex(floatingLeft: number, listLeft: number, slotWidth: number, tabCount: number) {
  if (tabCount < 2 || slotWidth <= 0) return 0
  return Math.max(0, Math.min(tabCount - 1, Math.round((floatingLeft - listLeft) / slotWidth)))
}

function resetTabDrag() {
  tabDragging.value = false
  tabDrag.id = ''
  tabDrag.pointerId = -1
  tabDrag.moved = false
}

function reorderHeader(fromIndex: number, toIndex: number) {
  const session = activeSession.value
  if (!session || fromIndex === toIndex || fromIndex < 0 || fromIndex >= headerItems.value.length) return false
  const sequence = headerItems.value.map((item) => item.id)
  const [id] = sequence.splice(fromIndex, 1)
  sequence.splice(Math.max(0, Math.min(toIndex, sequence.length)), 0, id)
  const tabById = new Map(session.tabs.map((tab) => [tab.id, tab]))
  session.tabs = sequence.filter((itemId) => itemId !== '__memo__').map((itemId) => tabById.get(itemId)!).filter(Boolean)
  session.memoTabIndex = Math.max(0, sequence.indexOf('__memo__'))
  return true
}

function beginTabPointer(event: PointerEvent, item: HeaderItem) {
  if (event.button !== 0 || tabDrag.pointerId !== -1) return
  const element = event.currentTarget as HTMLElement
  const list = tabList.value
  if (!list) return
  const rect = element.getBoundingClientRect()
  tabDrag.id = item.id
  tabDrag.pointerId = event.pointerId
  tabDrag.startX = event.clientX
  tabDrag.offsetX = event.clientX - rect.left
  tabDrag.left = rect.left
  tabDrag.top = rect.top
  tabDrag.width = rect.width
  tabDrag.height = rect.height
  tabDrag.moved = false
  list.setPointerCapture(event.pointerId)
}

function moveTabPointer(event: PointerEvent) {
  if (event.pointerId !== tabDrag.pointerId || !tabDrag.id) return
  if (!tabDrag.moved && Math.abs(event.clientX - tabDrag.startX) < 6) return
  const list = tabList.value
  if (!list || !activeSession.value) return

  tabDrag.moved = true
  tabDragging.value = true
  const listRect = list.getBoundingClientRect()
  const maximumLeft = Math.max(listRect.left, listRect.right - tabDrag.width)
  tabDrag.left = Math.max(listRect.left, Math.min(event.clientX - tabDrag.offsetX, maximumLeft))

  const currentIndex = headerItems.value.findIndex((item) => item.id === tabDrag.id)
  const floatingCenter = tabDrag.left + tabDrag.width / 2
  if (currentIndex > 0) {
    const previous = headerItems.value[currentIndex - 1]
    const element = list.querySelector<HTMLElement>(`.browser-tab[data-tab-id="${CSS.escape(previous.id)}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && floatingCenter < rect.left + rect.width / 2) reorderHeader(currentIndex, currentIndex - 1)
  } else if (currentIndex < headerItems.value.length - 1) {
    const next = headerItems.value[currentIndex + 1]
    const element = list.querySelector<HTMLElement>(`.browser-tab[data-tab-id="${CSS.escape(next.id)}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && floatingCenter > rect.left + rect.width / 2) reorderHeader(currentIndex, currentIndex + 1)
  }
  if (currentIndex > 0 && currentIndex < headerItems.value.length - 1) {
    const currentNow = headerItems.value.findIndex((item) => item.id === tabDrag.id)
    if (currentNow === currentIndex) {
      const next = headerItems.value[currentIndex + 1]
      const element = list.querySelector<HTMLElement>(`.browser-tab[data-tab-id="${CSS.escape(next.id)}"]`)
      const rect = element?.getBoundingClientRect()
      if (rect && floatingCenter > rect.left + rect.width / 2) reorderHeader(currentIndex, currentIndex + 1)
    }
  }
  event.preventDefault()
}

function endTabPointer(event: PointerEvent) {
  if (event.pointerId !== tabDrag.pointerId) return
  const list = tabList.value
  const item = headerItems.value.find((headerItem) => headerItem.id === tabDrag.id)
  if (list?.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId)
  const moved = tabDrag.moved
  resetTabDrag()
  if (moved) persist()
  else if (item?.kind === 'browser') void activateTab(item.tab)
  else if (item?.kind === 'memo') void showMemo()
}

function cancelTabPointer(event: PointerEvent) {
  if (event.pointerId !== tabDrag.pointerId) return
  const list = tabList.value
  if (list?.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId)
  if (tabDrag.moved) persist()
  resetTabDrag()
}

function reorderFavoriteByIndex(fromIndex: number, toIndex: number) {
  if (!state.value || fromIndex === toIndex || fromIndex < 0 || fromIndex >= state.value.favorites.length) return false
  const [favorite] = state.value.favorites.splice(fromIndex, 1)
  favorite.folderId = ''
  state.value.favorites.splice(Math.max(0, Math.min(toIndex, state.value.favorites.length)), 0, favorite)
  return true
}

function resetFavoriteDrag() {
  favoriteDragging.value = false
  favoriteDrag.id = ''
  favoriteDrag.pointerId = -1
  favoriteDrag.moved = false
}

function beginFavoritePointer(event: PointerEvent, favorite: Favorite) {
  if (event.button !== 0 || favoriteDrag.pointerId !== -1 || !favoriteBar.value) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  Object.assign(favoriteDrag, {
    id: favorite.id, pointerId: event.pointerId, startX: event.clientX,
    offsetX: event.clientX - rect.left, left: rect.left, top: rect.top, width: rect.width, height: rect.height, moved: false,
  })
  favoriteBar.value.setPointerCapture(event.pointerId)
}

function moveFavoritePointer(event: PointerEvent) {
  if (event.pointerId !== favoriteDrag.pointerId || !favoriteDrag.id || !favoriteBar.value || !state.value) return
  if (!favoriteDrag.moved && Math.abs(event.clientX - favoriteDrag.startX) < 6) return
  favoriteDrag.moved = true
  favoriteDragging.value = true
  const barRect = favoriteBar.value.getBoundingClientRect()
  favoriteDrag.left = Math.max(barRect.left, Math.min(event.clientX - favoriteDrag.offsetX, barRect.right - favoriteDrag.width))
  const currentIndex = state.value.favorites.findIndex((item) => item.id === favoriteDrag.id)
  const center = favoriteDrag.left + favoriteDrag.width / 2
  const previous = state.value.favorites[currentIndex - 1]
  const next = state.value.favorites[currentIndex + 1]
  if (previous) {
    const element = favoriteBar.value.querySelector<HTMLElement>(`[data-favorite-id="${CSS.escape(previous.id)}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && center < rect.left + rect.width / 2) reorderFavoriteByIndex(currentIndex, currentIndex - 1)
  } else if (next) {
    const element = favoriteBar.value.querySelector<HTMLElement>(`[data-favorite-id="${CSS.escape(next.id)}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && center > rect.left + rect.width / 2) reorderFavoriteByIndex(currentIndex, currentIndex + 1)
  }
  const currentNow = state.value.favorites.findIndex((item) => item.id === favoriteDrag.id)
  const nextNow = state.value.favorites[currentNow + 1]
  if (nextNow) {
    const element = favoriteBar.value.querySelector<HTMLElement>(`[data-favorite-id="${CSS.escape(nextNow.id)}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && center > rect.left + rect.width / 2) reorderFavoriteByIndex(currentNow, currentNow + 1)
  }
  event.preventDefault()
}

function endFavoritePointer(event: PointerEvent) {
  if (event.pointerId !== favoriteDrag.pointerId) return
  const favorite = draggedFavorite.value
  if (favoriteBar.value?.hasPointerCapture(event.pointerId)) favoriteBar.value.releasePointerCapture(event.pointerId)
  const moved = favoriteDrag.moved
  resetFavoriteDrag()
  if (moved) persist()
  else if (favorite) void openFavorite(favorite)
}

function cancelFavoritePointer(event: PointerEvent) {
  if (event.pointerId !== favoriteDrag.pointerId) return
  if (favoriteBar.value?.hasPointerCapture(event.pointerId)) favoriteBar.value.releasePointerCapture(event.pointerId)
  if (favoriteDrag.moved) persist()
  resetFavoriteDrag()
}

function normalizeUrl(input: string) {
  const value = input.trim()
  if (!value) return 'https://www.bing.com/'
  if (/^https?:\/\//i.test(value)) return value
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value)) return `https://${value}`
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
}

function navigate() {
  const url = normalizeUrl(address.value)
  address.value = url
  if (activeTab.value) {
    activeTab.value.url = url
    persist()
    void webviewFor(activeTab.value.id)?.loadURL(url)
  }
}

function browserAction(action: 'back' | 'forward' | 'reload' | 'stop') {
  const view = activeTab.value ? webviewFor(activeTab.value.id) : null
  if (!view) return
  if (action === 'back' && view.canGoBack()) view.goBack()
  if (action === 'forward' && view.canGoForward()) view.goForward()
  if (action === 'reload') view.reload()
  if (action === 'stop') view.stop()
}

function toggleSidebar() {
  if (!state.value) return
  state.value.settings.sidebarCollapsed = !state.value.settings.sidebarCollapsed
  persist()
}

async function showMemo(session = activeSession.value) {
  if (!session || !state.value) return
  state.value.activeSessionId = session.id
  session.memoTabVisible = true
  session.memoActive = true
  touchRecent(recentSessionIds.value, session.id)
  scheduleRetentionTrim()
  persist()
  void syncGuestPerformance()
}

function hideMemo() {
  const session = activeSession.value
  if (!session) return
  session.memoTabVisible = false
  session.memoActive = false
  persist()
  const tab = session.tabs.find((item) => item.id === session.activeTabId) || session.tabs[0]
  if (tab) void activateTab(tab)
}

async function openModal(kind: ModalKind) {
  if (!kind) return
  modalKind.value = kind
}

function closeModal() {
  modalKind.value = ''
}

async function openNewSession() {
  editingSessionId.value = ''
  sessionDraft.name = '新会话'
  sessionDraft.recycleMode = 'never'
  sessionDraft.customRecycleDays = null
  await openModal('session')
}

async function editSession(session: BrowserSession) {
  editingSessionId.value = session.id
  sessionDraft.name = session.name
  const days = remainingDays(session)
  sessionDraft.recycleMode = days !== null && [1, 7, 15, 30].includes(days) ? String(days) : days === null ? 'never' : 'custom'
  sessionDraft.customRecycleDays = sessionDraft.recycleMode === 'custom' ? days : null
  await openModal('session')
}

async function saveSession() {
  if (!state.value || !sessionDraft.name.trim()) return
  let target = state.value.sessions.find((item) => item.id === editingSessionId.value)
  if (!target) {
    target = createSession(sessionDraft.name.trim())
    state.value.sessions.unshift(target)
    state.value.activeSessionId = target.id
  }
  target.name = sessionDraft.name.trim()
  const days = sessionDraft.recycleMode === 'never'
    ? null
    : sessionDraft.recycleMode === 'custom'
      ? (sessionDraft.customRecycleDays !== null && Number.isFinite(Number(sessionDraft.customRecycleDays)) ? Math.max(1, Math.floor(Number(sessionDraft.customRecycleDays))) : null)
      : Number(sessionDraft.recycleMode)
  if (sessionDraft.recycleMode === 'custom' && days === null) {
    notify('请输入自定义回收天数')
    return
  }
  target.expiresAt = null
  target.recycleAfterDays = days
  target.recycleDaysRemaining = days
  target.recycleLastCheckedDate = days && clockNow.value ? networkDateKey(clockNow.value) : null
  persist()
  closeModal()
  await activateSession(target)
}

function sessionMenuOptions(session: BrowserSession) {
  return [
    { label: '编辑会话', key: 'edit', icon: () => h(NIcon, null, { default: () => h(CreateOutline) }) },
    { label: session.memoTabVisible ? '隐藏备注标签' : '显示备注标签', key: 'memo', icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }) },
    { label: '导出加密会话', key: 'export', icon: () => h(NIcon, null, { default: () => h(CloudUploadOutline) }) },
    { type: 'divider', key: 'divider' },
    { label: '重建浏览数据', key: 'rebuild', icon: () => h(NIcon, null, { default: () => h(RefreshOutline) }) },
    { label: '移入回收站', key: 'delete', icon: () => h(NIcon, { color: '#e45454' }, { default: () => h(TrashOutline) }) },
  ]
}

function sidebarToolOptions() {
  return [
    { label: '导入会话', key: 'import', icon: () => h(NIcon, null, { default: () => h(CloudDownloadOutline) }) },
    { label: '插件', key: 'plugins', icon: () => h(NIcon, null, { default: () => h(ExtensionPuzzleOutline) }) },
    { label: `回收站${state.value?.recycleBin.length ? `（${state.value.recycleBin.length}）` : ''}`, key: 'recycle', icon: () => h(NIcon, null, { default: () => h(TrashOutline) }) },
    { label: '设置', key: 'settings', icon: () => h(NIcon, null, { default: () => h(CogOutline) }) },
  ]
}

function handleSidebarTool(key: string) {
  if (key === 'import') openImportSession()
  if (key === 'plugins') void openPlugins()
  if (key === 'recycle') void openModal('recycle')
  if (key === 'settings') void openSettings()
}

async function handleSessionMenu(key: string, session: BrowserSession) {
  if (key === 'edit') await editSession(session)
  if (key === 'memo') {
    session.memoTabVisible = !session.memoTabVisible
    if (!session.memoTabVisible && session.memoActive) session.memoActive = false
    persist()
  }
  if (key === 'export') openExportSession(session)
  if (key === 'rebuild') {
    for (const tab of session.tabs) removeLiveTab(tab.id)
    await nextTick()
    await api.browser.clearSession(session.id)
    for (const tab of session.tabs) Object.assign(tab, { title: '新标签页', favicon: '', loading: false, canGoBack: false, canGoForward: false })
    persist()
    if (session.id === activeSession.value?.id && !session.memoActive) await activateTab(session.tabs.find((item) => item.id === session.activeTabId) || session.tabs[0])
    notify('浏览数据已重建')
  }
  if (key === 'delete') await moveToRecycle(session)
}

async function moveToRecycle(session: BrowserSession) {
  if (!state.value) return
  for (const tab of session.tabs) removeLiveTab(tab.id)
  state.value.sessions = state.value.sessions.filter((item) => item.id !== session.id)
  const now = trustedNow()
  state.value.recycleBin.unshift({ session, deletedAt: now ? new Date(now).toISOString() : '' })
  if (!state.value.sessions.length) state.value.sessions.push(createSession('默认会话'))
  if (state.value.activeSessionId === session.id) state.value.activeSessionId = state.value.sessions[0].id
  persist()
  await activateSession(state.value.sessions.find((item) => item.id === state.value!.activeSessionId)!)
}

async function restoreSession(index: number) {
  if (!state.value) return
  const [item] = state.value.recycleBin.splice(index, 1)
  state.value.sessions.unshift(item.session)
  persist()
}

async function permanentlyDelete(index: number) {
  if (!state.value) return
  const [item] = state.value.recycleBin.splice(index, 1)
  await api.browser.clearSession(item.session.id)
  persist()
}

async function openFavorites(folderId = '') {
  favoriteViewFolderId.value = ''
  favoriteDraft.id = ''
  favoriteDraft.title = activeTab.value?.title || ''
  favoriteDraft.url = activeTab.value?.url || ''
  favoriteDraft.folderId = ''
  await openModal('favorites')
}

function saveFavorite() {
  if (!state.value || !favoriteDraft.title.trim()) return
  const url = normalizeUrl(favoriteDraft.url)
  const existing = state.value.favorites.find((item) => item.id === favoriteDraft.id)
  if (existing) {
    Object.assign(existing, { title: favoriteDraft.title.trim(), url, folderId: '' })
  } else {
    state.value.favorites.push({ id: uid(), title: favoriteDraft.title.trim(), url, favicon: activeTab.value?.url === url ? activeTab.value.favicon : '', folderId: '', createdAt: new Date().toISOString() })
  }
  favoriteDraft.id = ''
  favoriteDraft.title = ''
  favoriteDraft.url = ''
  persist()
  notify('收藏已保存')
}

function editFavorite(favorite: Favorite) {
  Object.assign(favoriteDraft, { id: favorite.id, title: favorite.title, url: favorite.url, folderId: '' })
}

function deleteFavorite(favorite: Favorite) {
  if (!state.value) return
  state.value.favorites = state.value.favorites.filter((item) => item.id !== favorite.id)
  persist()
}

function toggleCurrentFavorite() {
  if (!state.value || !activeTab.value) return
  const existing = state.value.favorites.find((item) => item.url === activeTab.value!.url)
  if (existing) {
    deleteFavorite(existing)
    notify('已取消收藏')
  } else {
    state.value.favorites.push({ id: uid(), title: activeTab.value.title, url: activeTab.value.url, favicon: activeTab.value.favicon, folderId: '', createdAt: new Date().toISOString() })
    persist()
    notify('已添加到收藏夹')
  }
}

function addFolder() {
  if (!state.value || !newFolderName.value.trim()) return
  const editing = state.value.favoriteFolders.find((folder) => folder.id === editingFolderId.value)
  if (editing) editing.name = newFolderName.value.trim()
  else {
    const folder = { id: uid(), name: newFolderName.value.trim(), parentId: favoriteViewFolderId.value }
    state.value.favoriteFolders.push(folder)
    favoriteViewFolderId.value = folder.id
    favoriteDraft.folderId = folder.id
  }
  newFolderName.value = ''
  editingFolderId.value = ''
  persist()
}

function editFolder(folder: FavoriteFolder) {
  editingFolderId.value = folder.id
  newFolderName.value = folder.name
}

function deleteFolder(folder: FavoriteFolder) {
  if (!state.value) return
  for (const child of state.value.favoriteFolders) if (child.parentId === folder.id) child.parentId = folder.parentId
  for (const favorite of state.value.favorites) if (favorite.folderId === folder.id) favorite.folderId = folder.parentId
  state.value.favoriteFolders = state.value.favoriteFolders.filter((item) => item.id !== folder.id)
  if (favoriteViewFolderId.value === folder.id) favoriteViewFolderId.value = folder.parentId
  persist()
}

function favoriteMenuOptions(favorite: Favorite) {
  return [
    { label: '打开', key: `open:${favorite.id}` },
    { label: '编辑', key: `edit:${favorite.id}` },
    { type: 'divider', key: 'divider' },
    { label: '删除', key: `delete:${favorite.id}` },
  ]
}

function folderMenuOptions(folder: FavoriteFolder) {
  const contentOptions = (folderId: string, visited = new Set<string>()): any[] => {
    if (visited.has(folderId)) return []
    visited.add(folderId)
    const children = state.value?.favoriteFolders.filter((item) => item.parentId === folderId) || []
    const favorites = state.value?.favorites.filter((item) => item.folderId === folderId) || []
    return [
      ...children.map((item) => {
        const nested = contentOptions(item.id, new Set(visited))
        return { label: `📁 ${item.name}`, key: `folder:${item.id}`, children: nested.length ? nested : [{ label: '空文件夹', key: `empty:${item.id}`, disabled: true }] }
      }),
      ...favorites.map((item) => ({ label: item.title, key: `open:${item.id}` })),
    ]
  }
  const content = contentOptions(folder.id)
  return [
    ...content,
    ...(content.length ? [{ type: 'divider' as const, key: 'content-divider' }] : [{ label: '空文件夹', key: `empty:${folder.id}`, disabled: true }]),
    { label: '管理此文件夹', key: `folder:${folder.id}` },
    { label: '重命名', key: `edit-folder:${folder.id}` },
    { label: '删除文件夹', key: `delete-folder:${folder.id}` },
  ]
}

function handleFavoriteMenu(key: string) {
  if (!state.value) return
  const [action, id] = key.split(':')
  const favorite = state.value.favorites.find((item) => item.id === id)
  const folder = state.value.favoriteFolders.find((item) => item.id === id)
  if (action === 'open' && favorite) void openFavorite(favorite)
  if (action === 'edit' && favorite) { editFavorite(favorite); void openModal('favorites') }
  if (action === 'delete' && favorite) deleteFavorite(favorite)
  if (action === 'folder' && folder) void openFavorites(folder.id)
  if (action === 'edit-folder' && folder) { favoriteViewFolderId.value = folder.parentId; editFolder(folder); void openModal('favorites') }
  if (action === 'delete-folder' && folder) deleteFolder(folder)
}

function beginFavoriteDrag(event: DragEvent, favorite: Favorite) {
  draggedFavoriteId.value = favorite.id
  draggedFolderId.value = ''
  event.dataTransfer?.setData('text/plain', `favorite:${favorite.id}`)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function beginFolderDrag(event: DragEvent, folder: FavoriteFolder) {
  draggedFolderId.value = folder.id
  draggedFavoriteId.value = ''
  event.dataTransfer?.setData('text/plain', `folder:${folder.id}`)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function endFavoriteDrag() {
  draggedFavoriteId.value = ''
  draggedFolderId.value = ''
}

function folderIsDescendant(folderId: string, possibleParentId: string) {
  if (folderId === possibleParentId) return true
  const visited = new Set<string>()
  let current = state.value?.favoriteFolders.find((item) => item.id === possibleParentId)
  while (current) {
    if (visited.has(current.id)) return true
    visited.add(current.id)
    if (current.parentId === folderId) return true
    current = state.value?.favoriteFolders.find((item) => item.id === current!.parentId)
  }
  return false
}

function selectFavoriteFolder(folderId: string) {
  favoriteViewFolderId.value = folderId
  if (!favoriteDraft.id) favoriteDraft.folderId = folderId
}

function dropIntoFolder(event: DragEvent, folderId: string) {
  event.preventDefault()
  if (!state.value) return
  const favorite = state.value.favorites.find((item) => item.id === draggedFavoriteId.value)
  if (favorite) favorite.folderId = folderId
  const folder = state.value.favoriteFolders.find((item) => item.id === draggedFolderId.value)
  if (folder && folder.id !== folderId && !folderIsDescendant(folder.id, folderId)) folder.parentId = folderId
  draggedFavoriteId.value = ''
  draggedFolderId.value = ''
  persist()
}

function dropOnFolder(event: DragEvent, target: FavoriteFolder) {
  event.preventDefault()
  if (!state.value) return
  if (draggedFavoriteId.value) {
    dropIntoFolder(event, target.id)
    return
  }
  const source = state.value.favoriteFolders.find((item) => item.id === draggedFolderId.value)
  if (!source || source.id === target.id) {
    endFavoriteDrag()
    return
  }
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const ratio = rect && rect.height ? (event.clientY - rect.top) / rect.height : .5
  if (ratio > .28 && ratio < .72) {
    dropIntoFolder(event, target.id)
    return
  }
  if (folderIsDescendant(source.id, target.parentId)) return
  const from = state.value.favoriteFolders.findIndex((item) => item.id === source.id)
  state.value.favoriteFolders.splice(from, 1)
  source.parentId = target.parentId
  const adjustedTarget = state.value.favoriteFolders.findIndex((item) => item.id === target.id)
  state.value.favoriteFolders.splice(adjustedTarget + (ratio >= .72 ? 1 : 0), 0, source)
  draggedFolderId.value = ''
  persist()
}

function reorderFavorite(event: DragEvent, target: Favorite) {
  event.preventDefault()
  if (!state.value || !draggedFavoriteId.value || draggedFavoriteId.value === target.id) return
  const from = state.value.favorites.findIndex((item) => item.id === draggedFavoriteId.value)
  const to = state.value.favorites.findIndex((item) => item.id === target.id)
  const [item] = state.value.favorites.splice(from, 1)
  item.folderId = target.folderId
  state.value.favorites.splice(to, 0, item)
  persist()
}

async function openQuickFavorite() {
  if (!activeTab.value) return
  const existing = state.value?.favorites.find((item) => item.url === activeTab.value!.url)
  if (existing) {
    favoriteViewFolderId.value = ''
    editFavorite(existing)
  } else {
    favoriteViewFolderId.value = ''
    Object.assign(favoriteDraft, { id: '', title: activeTab.value.title, url: activeTab.value.url, folderId: '' })
  }
  await openModal('favorites')
}

async function openFavorite(favorite: Favorite) {
  if (!activeSession.value) return
  const tab = createTab(favorite.url)
  activeSession.value.tabs.push(tab)
  await activateTab(tab)
}

function quickEditFavorite(favorite: Favorite) {
  favoriteViewFolderId.value = favorite.folderId
  editFavorite(favorite)
  void openModal('favorites')
}

function installedPlugin(pluginId: string) {
  return pluginState.value.installed.find((item) => item.id === pluginId) || null
}

function pluginIcon(plugin: { icon: string }) {
  if (plugin.icon === 'chatgpt') return ChatbubbleEllipsesOutline
  return ExtensionPuzzleOutline
}

function resetDistanceLabel(value: unknown) {
  const resetAt = Date.parse(String(value || ''))
  if (!Number.isFinite(resetAt)) return ''
  const difference = resetAt - (clockNow.value || Date.now())
  if (difference <= 0) return '即将重置'
  if (difference >= 86_400_000) return `${Math.ceil(difference / 86_400_000)}天重置`
  if (difference >= 3_600_000) return `${Math.ceil(difference / 3_600_000)}小时重置`
  return `${Math.max(1, Math.ceil(difference / 60_000))}分钟重置`
}

function nestedValue(value: unknown, dottedPath: string) {
  return dottedPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

function sessionPluginBadges(session: BrowserSession) {
  const badges: Array<{ key: string; label: string; type: 'default' | 'success' | 'warning' | 'error' | 'info'; title: string }> = []
  for (const plugin of pluginState.value.installed) {
    const result = pluginState.value.results[plugin.id]?.[session.id]
    if (!result) continue
    for (const [index, definition] of plugin.sessionBadges.entries()) {
      if (definition.whenStatus !== result.status) continue
      const fieldValue = definition.field ? result.fields[definition.field] : undefined
      let label = definition.label || ''
      if (definition.format === 'reset-distance') label = resetDistanceLabel(fieldValue)
      else if (definition.format) label = definition.format.replace('{value}', String(fieldValue ?? ''))
      if (!label) continue
      badges.push({
        key: `${plugin.id}:${index}`,
        label,
        type: definition.type || 'default',
        title: definition.tooltipField ? String(nestedValue(result, definition.tooltipField) || '') : result.message || '',
      })
    }
  }
  return badges
}

async function openPlugins() {
  pluginSettingsId.value = ''
  deletePluginConfig.value = false
  pluginState.value = await api.plugins.getState()
  await openModal('plugins')
  pluginCenterBusy.value = 'catalog'
  try { pluginState.value = await api.plugins.refreshCatalog() } catch (error) { notify(error instanceof Error ? error.message : '插件目录更新失败') }
  finally { pluginCenterBusy.value = '' }
}

async function installPlugin(pluginId: string) {
  const updating = Boolean(installedPlugin(pluginId))
  pluginCenterBusy.value = `install:${pluginId}`
  try {
    pluginState.value = await api.plugins.install(pluginId)
    pluginCenterTab.value = 'installed'
    notify(updating ? '插件已安全更新，配置保持不变' : '插件安装完成，正在首次更新')
  } catch (error) { notify(error instanceof Error ? error.message : '插件安装失败') }
  finally { pluginCenterBusy.value = '' }
}

async function importPlugin() {
  pluginCenterBusy.value = 'import'
  try {
    const result = await api.plugins.import()
    if (result.canceled) return
    pluginState.value = result.state
    pluginCenterTab.value = 'installed'
    notify('本地插件已校验并导入')
  } catch (error) { notify(error instanceof Error ? error.message : '插件导入失败') }
  finally { pluginCenterBusy.value = '' }
}

function openPluginSettings(plugin: InstalledPlugin | null) {
  if (!plugin) return
  pluginSettingsId.value = plugin.id
  pluginConfigDraft.value = { ...plugin.config }
  deletePluginConfig.value = false
}

function settingVisible(setting: PluginSettingSchema) {
  return !setting.visibleWhen || pluginConfigDraft.value[setting.visibleWhen.key] === setting.visibleWhen.equals
}

function setPluginSetting(setting: PluginSettingSchema, value: string | number | boolean | null) {
  if (value === null) return
  pluginConfigDraft.value[setting.key] = value
}

function selectSettingValue(setting: PluginSettingSchema) {
  const value = pluginConfigDraft.value[setting.key]
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function selectSettingOptions(setting: PluginSettingSchema) {
  return (setting.options || []).filter((option) => typeof option.value === 'string' || typeof option.value === 'number')
}

async function savePluginSettings() {
  if (!pluginSettingsId.value) return
  pluginCenterBusy.value = `settings:${pluginSettingsId.value}`
  try {
    pluginState.value = await api.plugins.updateConfig(pluginSettingsId.value, pluginConfigDraft.value)
    notify('插件设置已保存')
  } catch (error) { notify(error instanceof Error ? error.message : '插件设置保存失败') }
  finally { pluginCenterBusy.value = '' }
}

async function runPlugin(pluginId: string) {
  pluginCenterBusy.value = `run:${pluginId}`
  try {
    const result = await api.plugins.run(pluginId)
    pluginState.value = result.state
    notify(result.refreshed ? `已依次更新 ${result.refreshed} 个会话` : '没有找到打开过对应网站的会话')
  } catch (error) { notify(error instanceof Error ? error.message : '插件更新失败') }
  finally { pluginCenterBusy.value = '' }
}

async function uninstallPlugin(pluginId: string) {
  pluginCenterBusy.value = `uninstall:${pluginId}`
  try {
    pluginState.value = await api.plugins.uninstall(pluginId, deletePluginConfig.value)
    pluginSettingsId.value = ''
    notify(deletePluginConfig.value ? '插件及其配置已删除' : '插件已卸载，配置已保留')
  } catch (error) { notify(error instanceof Error ? error.message : '插件卸载失败') }
  finally { pluginCenterBusy.value = '' }
}

async function openSettings() {
  if (!state.value) return
  Object.assign(settingsDraft, {
    closeBehavior: state.value.settings.closeBehavior,
    maximizeBehavior: state.value.settings.maximizeBehavior,
    performanceTier: state.value.settings.performanceTier,
  })
  await openModal('settings')
}

function saveSettings() {
  if (!state.value) return
  const performanceChanged = state.value.settings.performanceTier !== settingsDraft.performanceTier
  Object.assign(state.value.settings, {
    closeBehavior: settingsDraft.closeBehavior,
    maximizeBehavior: settingsDraft.maximizeBehavior,
    performanceTier: settingsDraft.performanceTier,
    performanceSelectionSource: performanceChanged ? 'manual' : state.value.settings.performanceSelectionSource,
  })
  persist()
  applyPerformanceEnvironment()
  closeModal()
}

function formatUpdateBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 MB'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  return `${(value / 1024 ** 2).toFixed(value >= 100 * 1024 ** 2 ? 0 : 1)} MB`
}

function handleUpdateStatus(status: UpdateStatus) {
  updateInfo.value = status
  if (status.phase === 'available' && !modalShown.value) void openModal('update')
}

async function checkForUpdatesManually() {
  const result = await api.update.check()
  updateInfo.value = result
  if (result.phase === 'available') {
    closeModal()
    await nextTick()
    await openModal('update')
  } else if (result.phase === 'up-to-date') notify(`当前已是最新版 v${result.currentVersion}`)
  else if (result.phase === 'error' || result.phase === 'unsupported') notify(result.error || '检查更新失败')
}

async function downloadAvailableUpdate() {
  updateInfo.value = await api.update.download()
}

async function installAvailableUpdate() {
  await api.update.install()
}

async function ignoreAvailableUpdate() {
  const version = updateInfo.value.candidate?.version
  if (!version) return
  await api.update.ignore(version)
  closeModal()
  notify(`已忽略 v${version}，仍可在设置中手动检查`)
}

function openGithubProject() {
  void api.shell.open('https://github.com/aafqaq/StarBrowser')
}

function windowControl(action: 'minimize' | 'maximize' | 'close') {
  api.window.control(action)
}

function closeChoice(action: 'tray' | 'exit') {
  if (browserPersistTimer) flushBrowserPersist()
  api.app.closeChoice({ action, remember: rememberClose.value })
  modalKind.value = ''
}

function flushHiddenBrowserState() {
  if (document.hidden && browserPersistTimer) flushBrowserPersist()
}

function trustedNow() {
  if (!trustedTimeBase) return 0
  return Math.round(trustedTimeBase + performance.now() - trustedPerformanceBase)
}

function networkDateKey(value: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '00'
  return `${part('year')}-${part('month')}-${part('day')}`
}

function dateKeyDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) : null
}

async function syncNetworkTimeAndMaintenance() {
  const result = await api.time.sync()
  if (!result.ok || !Number.isFinite(result.now)) {
    notify(result.error || '网络时间同步失败，本次启动不会扣减会话天数')
    return
  }
  trustedTimeBase = Number(result.now)
  trustedPerformanceBase = performance.now()
  clockNow.value = trustedNow()
  await runMaintenance()
}

async function runMaintenance() {
  if (!state.value) return
  const now = trustedNow()
  if (!now) return
  clockNow.value = now
  const today = networkDateKey(now)
  const todayDay = dateKeyDay(today)!
  let changed = false
  for (const session of [...state.value.sessions]) {
    if (session.recycleDaysRemaining === null && session.expiresAt) {
      session.recycleAfterDays = Math.max(0, Math.ceil((new Date(session.expiresAt).getTime() - now) / 86_400_000))
      session.recycleDaysRemaining = session.recycleAfterDays
      session.expiresAt = null
      changed = true
    }
    if (session.recycleDaysRemaining === null) continue
    const lastDay = session.recycleLastCheckedDate ? dateKeyDay(session.recycleLastCheckedDate) : null
    if (lastDay === null) {
      session.recycleLastCheckedDate = today
      changed = true
    } else if (todayDay > lastDay) {
      session.recycleDaysRemaining = Math.max(0, session.recycleDaysRemaining - (todayDay - lastDay))
      session.recycleLastCheckedDate = today
      changed = true
    }
    if (session.recycleDaysRemaining <= 0) {
      await moveToRecycle(session)
      changed = true
    }
  }
  for (let index = state.value.recycleBin.length - 1; index >= 0; index--) {
    const deletedAt = new Date(state.value.recycleBin[index].deletedAt).getTime()
    if (Number.isFinite(deletedAt) && now - deletedAt > 30 * 24 * 60 * 60 * 1000) {
      await permanentlyDelete(index)
      changed = true
    }
  }
  if (changed) persist()
}

function tabForWebviewEvent(event: Event) {
  const view = event.currentTarget as StarBrowserWebviewElement
  const tabId = view.dataset.tabId || ''
  for (const session of state.value?.sessions || []) {
    const tab = session.tabs.find((item) => item.id === tabId)
    if (tab) return { tab, view }
  }
  return null
}

function patchWebviewTab(event: Event, patch: Partial<BrowserTab>) {
  const target = tabForWebviewEvent(event)
  if (!target) return
  const changedKeys = (Object.keys(patch) as Array<keyof BrowserTab>).filter((key) => target.tab[key] !== patch[key])
  if (!changedKeys.length) return
  Object.assign(target.tab, patch)
  if (target.tab.id === activeTab.value?.id && patch.url) address.value = patch.url
  if (changedKeys.some((key) => key === 'url' || key === 'title' || key === 'favicon')) scheduleBrowserPersist()
}

function webviewNavigationStarted(event: Event) {
  const detail = event as Event & { isMainFrame?: boolean }
  if (detail.isMainFrame === false) return
  const target = tabForWebviewEvent(event)
  if (!target) return
  mainFrameNavigationCounts.set(target.tab.id, (mainFrameNavigationCounts.get(target.tab.id) || 0) + 1)
}

function webviewReady(event: Event) {
  const target = tabForWebviewEvent(event)
  if (!target) return
  patchWebviewTab(event, {
    url: target.view.getURL() || target.tab.url,
    title: target.view.getTitle() || target.tab.title,
    canGoBack: target.view.canGoBack(),
    canGoForward: target.view.canGoForward(),
  })
  if (!readyTabIds.value.includes(target.tab.id)) readyTabIds.value.push(target.tab.id)
  if (target.tab.id === activeTab.value?.id) scheduleRetentionTrim(120)
  void syncGuestPerformance()
}

function webviewStopped(event: Event) {
  const target = tabForWebviewEvent(event)
  if (!target) return
  patchWebviewTab(event, {
    loading: false,
    url: target.view.getURL() || target.tab.url,
    title: target.view.getTitle() || target.tab.title,
    canGoBack: target.view.canGoBack(),
    canGoForward: target.view.canGoForward(),
  })
  if (!readyTabIds.value.includes(target.tab.id)) readyTabIds.value.push(target.tab.id)
}

function webviewNavigated(event: Event) {
  const detail = event as Event & { url?: string }
  const target = tabForWebviewEvent(event)
  if (!target) return
  patchWebviewTab(event, {
    url: detail.url || target.view.getURL() || target.tab.url,
    canGoBack: target.view.canGoBack(),
    canGoForward: target.view.canGoForward(),
  })
}

function webviewTitle(event: Event) {
  patchWebviewTab(event, { title: (event as Event & { title?: string }).title || '新标签页' })
}

function webviewFavicon(event: Event) {
  const favicon = (event as Event & { favicons?: string[] }).favicons?.[0] || ''
  const target = tabForWebviewEvent(event)
  if (!target) return
  patchWebviewTab(event, { favicon })
  if (favicon && state.value) {
    for (const favorite of state.value.favorites) {
      if (favorite.url === target.tab.url && favorite.favicon !== favicon) favorite.favicon = favicon
    }
    persist()
  }
}

function webviewFailed(event: Event) {
  const detail = event as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
  if (detail.isMainFrame !== false && detail.errorCode !== -3) {
    patchWebviewTab(event, { loading: false, title: `加载失败：${detail.errorDescription || '未知错误'}`, url: detail.validatedURL || '' })
    const target = tabForWebviewEvent(event)
    if (target && !readyTabIds.value.includes(target.tab.id)) readyTabIds.value.push(target.tab.id)
  }
}

async function webviewGone(event: Event) {
  const target = tabForWebviewEvent(event)
  if (!target) return
  const owner = state.value?.sessions.find((session) => session.tabs.some((tab) => tab.id === target.tab.id)) || null
  const shouldRestore = target.tab.id === activeTab.value?.id && owner?.id === activeSession.value?.id
  removeLiveTab(target.tab.id)
  Object.assign(target.tab, { loading: false, title: '页面进程已恢复，正在重新载入' })
  if (shouldRestore && owner) {
    await nextTick()
    ensureLiveTab(target.tab, owner)
  }
}

onMounted(async () => {
  document.addEventListener('pointerup', releasePointerButtonFocus, true)
  document.addEventListener('visibilitychange', flushHiddenBrowserState)
  const [loadedState, detectedProfile, loadedPlugins] = await Promise.all([api.state.get(), api.system.performanceProfile(), api.plugins.getState()])
  state.value = loadedState
  machineProfile.value = detectedProfile
  pluginState.value = loadedPlugins
  updateInfo.value = await api.update.getStatus()
  await nextTick()
  if (sessionList.value) sessionScrollbar = new PerfectScrollbar(sessionList.value, { suppressScrollX: true, wheelPropagation: false })
  const session = activeSession.value
  if (session) {
    address.value = activeTab.value?.url || ''
    if (!session.memoActive && activeTab.value) await activateTab(activeTab.value)
  }
  applyPerformanceEnvironment()
  void refreshMemoryStatus()
  performanceMonitorTimer = window.setInterval(() => void refreshMemoryStatus(), 15_000)
  void syncNetworkTimeAndMaintenance()
  maintenanceTimer = window.setInterval(() => {
    clockNow.value = trustedNow()
    trimLiveTabs()
    void syncGuestPerformance()
    void runMaintenance()
  }, 60_000)
  if (new URLSearchParams(location.search).get('smoke') === '1') {
    window.__starbrowserTest = {
      getTabOrder: () => activeSession.value?.tabs.map((tab) => tab.id) || [],
      reorderTabs: (fromIndex, toIndex) => {
        const changed = moveTabToIndex(fromIndex, toIndex)
        if (changed) persist()
        return changed
      },
      targetTabIndex,
      getHeaderOrder: () => headerItems.value.map((item) => item.id),
      reorderHeaderItems: (fromIndex, toIndex) => {
        const changed = reorderHeader(fromIndex, toIndex)
        if (changed) persist()
        return changed
      },
      memoRoundTrip: async () => {
        const tab = activeTab.value
        if (!tab) return { before: 0, during: 0, after: 0, retained: false, layout: { editorHeight: 0, wrapperHeight: 0, textareaHeight: 0, aligned: false } }
        await activateTab(tab)
        await nextTick()
        const before = await waitForGuestId(tab.id)
        await showMemo()
        await nextTick()
        const during = await waitForGuestId(tab.id)
        const editor = document.querySelector<HTMLElement>('.memo-editor')
        const textarea = editor?.querySelector<HTMLTextAreaElement>('textarea')
        const wrapper = editor?.querySelector<HTMLElement>('.n-input-wrapper')
        const editorRect = editor?.getBoundingClientRect()
        const textareaRect = textarea?.getBoundingClientRect()
        const wrapperRect = wrapper?.getBoundingClientRect()
        const layout = {
          editorHeight: editorRect?.height || 0,
          wrapperHeight: wrapperRect?.height || 0,
          textareaHeight: textareaRect?.height || 0,
          aligned: Boolean(editorRect && wrapperRect && textareaRect &&
            Math.abs(editorRect.height - wrapperRect.height) < 2 &&
            textareaRect.left >= editorRect.left && textareaRect.right <= editorRect.right + 1 &&
            textareaRect.top >= editorRect.top && textareaRect.bottom <= editorRect.bottom + 1 &&
            textareaRect.height > editorRect.height - 3),
        }
        await activateTab(tab)
        await nextTick()
        const after = await waitForGuestId(tab.id)
        return { before, during, after, retained: before > 0 && before === during && during === after, layout }
      },
      sessionSwitchTabOverlap: async () => {
        const original = activeSession.value
        if (!state.value || !original) return { expected: 0, finalCount: 0, maxCount: 0, noOverlap: false }
        const testSession = createSession('切换测试')
        testSession.tabs.push(createTab(), createTab())
        state.value.sessions.push(testSession)
        const list = tabList.value
        const countTabs = () => list?.querySelectorAll('.browser-tab:not(.memo-tab):not(.tab-drag-preview)').length || 0
        let maxCount = countTabs()
        const observer = new MutationObserver(() => { maxCount = Math.max(maxCount, countTabs()) })
        if (list) observer.observe(list, { childList: true, subtree: true })
        state.value.activeSessionId = testSession.id
        await nextTick()
        await new Promise((resolve) => window.setTimeout(resolve, 260))
        const finalCount = countTabs()
        observer.disconnect()
        state.value.activeSessionId = original.id
        state.value.sessions = state.value.sessions.filter((item) => item.id !== testSession.id)
        await nextTick()
        return { expected: 3, finalCount, maxCount, noOverlap: finalCount === 3 && maxCount <= 3 }
      },
      favoritesFlatCheck: () => Boolean(state.value && state.value.favoriteFolders.length === 0 && state.value.favorites.every((item) => item.folderId === '')),
      expiryBadgeCheck: async () => {
        const session = activeSession.value
        if (!session) return { days: -1, visible: false }
        const original = session.recycleDaysRemaining
        session.recycleDaysRemaining = 3
        await nextTick()
        const days = remainingDays(session) ?? -1
        const visible = [...document.querySelectorAll('.session-card.active .session-tags .n-tag')].some((element) => element.textContent?.includes(`剩余 ${days} 天`))
        session.recycleDaysRemaining = original
        await nextTick()
        return { days, visible }
      },
      neverRecycleCheck: async () => {
        if (!state.value) return false
        const session = createSession('永不回收测试')
        state.value.sessions.push(session)
        await runMaintenance()
        const preserved = state.value.sessions.some((item) => item.id === session.id) && !state.value.recycleBin.some((item) => item.session.id === session.id)
        state.value.sessions = state.value.sessions.filter((item) => item.id !== session.id)
        return preserved
      },
      prepareRecycleOverlayCheck: async () => {
        if (!state.value) return ''
        const session = createSession('浮层边界测试')
        state.value.recycleBin.unshift({ session, deletedAt: new Date().toISOString() })
        await nextTick()
        return session.id
      },
      cleanupRecycleOverlayCheck: async (sessionId) => {
        if (!state.value || !sessionId) return false
        state.value.recycleBin = state.value.recycleBin.filter((item) => item.session.id !== sessionId)
        await nextTick()
        return true
      },
      prepareShowcase: async () => {
        if (!state.value) return false
        for (const tabId of [...liveTabIds.value]) removeLiveTab(tabId)
        const work = createSession('开发工作')
        work.tabs = [createTab('https://github.com/trending'), createTab('https://github.com/aafqaq/StarBrowser'), createTab('https://developer.mozilla.org/zh-CN/')]
        work.tabs[0].title = 'GitHub Trending'
        work.tabs[1].title = 'StarBrowser'
        work.tabs[2].title = 'MDN Web Docs'
        work.tabs.forEach((tab) => { tab.favicon = 'https://github.githubassets.com/favicons/favicon.svg' })
        work.activeTabId = work.tabs[0].id
        work.memo = '本周工作记录\n\n• 检查多账号登录状态与会话隔离\n• 整理常用项目、文档和搜索入口\n• 发布前完成测试与数据备份\n\n这里可以长期记录大量备注，备注标签也能和网页标签一起拖动排序。'
        work.memoTabVisible = true
        work.memoTabIndex = 1
        work.recycleAfterDays = 30
        work.recycleDaysRemaining = 26
        const personal = createSession('个人生活')
        personal.tabs = [createTab('https://www.bing.com/maps?cp=31.2304~121.4737&lvl=11&style=r'), createTab('https://www.bing.com/images/trending')]
        personal.tabs[0].title = 'Bing 地图'
        personal.tabs[1].title = '热门图片'
        personal.tabs.forEach((tab) => { tab.favicon = 'https://www.bing.com/sa/simg/favicon-trans-bg-blue-mg.ico' })
        personal.activeTabId = personal.tabs[0].id
        personal.recycleAfterDays = 15
        personal.recycleDaysRemaining = 12
        const store = createSession('店铺运营')
        store.recycleAfterDays = 30
        store.recycleDaysRemaining = 29
        const temporary = createSession('临时测试')
        temporary.recycleAfterDays = 7
        temporary.recycleDaysRemaining = 5
        state.value.sessions = [work, personal, store, temporary]
        state.value.activeSessionId = work.id
        state.value.favorites = [
          { id: uid(), title: '热门项目', url: 'https://github.com/trending', favicon: 'https://github.githubassets.com/favicons/favicon.svg', folderId: '', createdAt: new Date().toISOString() },
          { id: uid(), title: 'StarBrowser', url: 'https://github.com/aafqaq/StarBrowser', favicon: 'https://github.githubassets.com/favicons/favicon.svg', folderId: '', createdAt: new Date().toISOString() },
          { id: uid(), title: 'Bing 地图', url: 'https://www.bing.com/maps', favicon: 'https://www.bing.com/sa/simg/favicon-trans-bg-blue-mg.ico', folderId: '', createdAt: new Date().toISOString() },
          { id: uid(), title: 'MDN 文档', url: 'https://developer.mozilla.org/zh-CN/', favicon: 'https://developer.mozilla.org/favicon-48x48.cbbd161b.png', folderId: '', createdAt: new Date().toISOString() },
        ]
        await nextTick()
        await activateSession(work)
        return true
      },
      showShowcaseSession: async (sessionIndex, tabIndex) => {
        if (!state.value) return false
        modalKind.value = ''
        const session = state.value.sessions[sessionIndex]
        const tab = session?.tabs[tabIndex]
        if (!session || !tab) return false
        await activateSession(session)
        await activateTab(tab)
        await nextTick()
        return activeSession.value?.id === session.id && activeTab.value?.id === tab.id
      },
      showFavoritesShowcase: async () => {
        await openFavorites()
        await nextTick()
        const card = document.querySelector<HTMLElement>('[data-testid="favorites-modal"]')
        const rect = card?.getBoundingClientRect()
        return Boolean(card && rect && rect.width > 500 && rect.height > 300 && card.textContent?.includes('收藏夹'))
      },
      showMemoShowcase: async () => {
        modalKind.value = ''
        const session = state.value?.sessions[0]
        if (!session) return false
        await showMemo(session)
        await nextTick()
        const editor = document.querySelector<HTMLElement>('.memo-editor')
        return Boolean(session.memoActive && editor && editor.getBoundingClientRect().height > 300)
      },
      showSessionEditorShowcase: async () => {
        modalKind.value = ''
        const session = state.value?.sessions[0]
        if (!session) return false
        await activateSession(session)
        const tab = session.tabs.find((item) => item.id === session.activeTabId) || session.tabs[0]
        if (tab) await activateTab(tab)
        await editSession(session)
        await nextTick()
        const card = document.querySelector<HTMLElement>('[data-testid="session-modal"]')
        return Boolean(card && card.textContent?.includes('自动移入回收站'))
      },
      showUpdateShowcase: async () => {
        modalKind.value = ''
        await nextTick()
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        updateInfo.value = await api.update.simulateForSmoke()
        modalKind.value = 'update'
        await nextTick()
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        const card = document.querySelector<HTMLElement>('[data-testid="update-modal"]')
        const content = document.querySelector<HTMLElement>('[data-testid="update-content"]')
        const cardRect = card?.getBoundingClientRect()
        const center = cardRect ? document.elementFromPoint(cardRect.left + cardRect.width / 2, cardRect.top + cardRect.height / 2) : null
        return {
          visible: Boolean(card && cardRect && cardRect.width > 500 && cardRect.height > 300 && content && card.textContent?.includes('软件更新') && center && card.contains(center)),
          width: cardRect?.width || 0,
          height: cardRect?.height || 0,
          title: card?.querySelector('.n-card-header__main')?.textContent || '',
        }
      },
      showSettingsShowcase: async () => {
        modalKind.value = ''
        await nextTick()
        await new Promise((resolve) => window.setTimeout(resolve, 700))
        modalKind.value = 'settings'
        await nextTick()
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        const card = document.querySelector<HTMLElement>('[data-testid="settings-modal"]')
        const rect = card?.getBoundingClientRect()
        const center = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
        return Boolean(rect && card && center && card.contains(center) && card.textContent?.includes('检查更新'))
      },
      showPluginsShowcase: async () => {
        modalKind.value = ''
        await nextTick()
        await openPlugins()
        await nextTick()
        const card = document.querySelector<HTMLElement>('[data-testid="plugins-modal"]')
        const rect = card?.getBoundingClientRect()
        return Boolean(card && rect && rect.width > 650 && rect.height > 400 && card.textContent?.includes('ChatGPT 用量展示'))
      },
      activateTabAt: async (index) => {
        const tab = activeSession.value?.tabs[index]
        if (!tab) return ''
        await activateTab(tab)
        return tab.id
      },
      activationStabilityCheck: async () => {
        const tab = activeTab.value
        if (!tab) return { guestStable: false, navigationStable: false, beforeGuestId: 0, afterGuestId: 0, beforeNavigations: -1, afterNavigations: -1 }
        await activateTab(tab)
        await nextTick()
        const beforeGuestId = await waitForGuestId(tab.id)
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        const beforeNavigations = mainFrameNavigationCounts.get(tab.id) || 0
        await activateTab(tab)
        await activateTab(tab)
        await activateTab(tab)
        await new Promise((resolve) => window.setTimeout(resolve, 350))
        const afterGuestId = guestIdFor(tab.id)
        const afterNavigations = mainFrameNavigationCounts.get(tab.id) || 0
        return {
          guestStable: beforeGuestId > 0 && beforeGuestId === afterGuestId,
          navigationStable: beforeNavigations === afterNavigations,
          beforeGuestId,
          afterGuestId,
          beforeNavigations,
          afterNavigations,
        }
      },
      performancePolicyCheck: async () => {
        const session = activeSession.value
        if (!state.value || !session) return { lowLiveTabs: 99, lowLiveSessions: 99, lowDomGuests: 99, mediumBudget: 0, highBudget: 0, ultraHighBudget: 0, fixedUnderCritical: false, criticalRuntimeBudget: 99, constrainedRuntimeBudget: 99, recommendedTier: '', lowVisualMode: false, restoredMode: false }
        const originalTier = state.value.settings.performanceTier
        const originalSource = state.value.settings.performanceSelectionSource
        const originalActiveTabId = session.activeTabId
        const originalMemoryStatus = memoryStatus.value
        state.value.settings.performanceTier = 'high'
        memoryStatus.value = { ...originalMemoryStatus, level: 'critical' }
        const fixedUnderCritical = currentPerformancePolicy.value.maxLiveTabs === performancePolicies.high.maxLiveTabs
        const criticalRuntimeBudget = runtimeLiveBudget()
        memoryStatus.value = { ...originalMemoryStatus, level: 'constrained' }
        const constrainedRuntimeBudget = runtimeLiveBudget()
        memoryStatus.value = originalMemoryStatus
        const created = [createTab(), createTab(), createTab(), createTab()]
        session.tabs.push(...created)
        state.value.settings.performanceTier = 'ultra-low'
        applyPerformanceEnvironment()
        for (const tab of created) {
          session.activeTabId = tab.id
          ensureLiveTab(tab, session)
          await nextTick()
        }
        trimLiveTabs()
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        const lowLiveTabs = liveTabIds.value.length
        const lowLiveSessions = new Set(liveTabs.value.map((entry) => entry.session.id)).size
        const lowDomGuests = document.querySelectorAll('webview.browser-webview').length
        const lowVisualMode = document.body.classList.contains('performance-low-mode') && document.querySelector('.app-shell')?.classList.contains('performance-low') === true
        for (const tab of created) removeLiveTab(tab.id)
        session.tabs = session.tabs.filter((tab) => !created.some((item) => item.id === tab.id))
        session.activeTabId = originalActiveTabId
        state.value.settings.performanceTier = originalTier
        state.value.settings.performanceSelectionSource = originalSource
        applyPerformanceEnvironment()
        const originalTab = session.tabs.find((tab) => tab.id === originalActiveTabId) || session.tabs[0]
        if (originalTab) await activateTab(originalTab)
        return {
          lowLiveTabs,
          lowLiveSessions,
          lowDomGuests,
          mediumBudget: performancePolicies.balanced.maxLiveTabs,
          highBudget: performancePolicies.high.maxLiveTabs,
          ultraHighBudget: performancePolicies['ultra-high'].maxLiveTabs,
          fixedUnderCritical,
          criticalRuntimeBudget,
          constrainedRuntimeBudget,
          recommendedTier: recommendedLowerTier('ultra-high', 'critical'),
          lowVisualMode,
          restoredMode: state.value.settings.performanceTier === originalTier && state.value.settings.performanceSelectionSource === originalSource,
        }
      },
    }
  }
})

const unsubscribe = [
  api.browser.onNewWindow(({ url }) => {
    const session = activeSession.value
    if (!session) return
    const tab = createTab(url)
    session.tabs.push(tab)
    void activateTab(tab)
  }),
  api.browser.onCommand((command) => {
    if (command === 'new-tab') void newTab()
    if (command === 'close-tab' && activeTab.value) void closeTab(activeTab.value)
    if (command === 'focus-address') document.querySelector<HTMLInputElement>('.address-input input')?.focus()
  }),
  api.window.onChanged((value) => { isMaximized.value = value.maximized || value.fullscreen }),
  api.app.onCloseRequest(() => { rememberClose.value = false; void openModal('close') }),
  api.update.onStatus(handleUpdateStatus),
  api.plugins.onState((value) => { pluginState.value = value }),
]

watch(activeTab, (tab) => { if (tab) address.value = tab.url })
watch(effectivePerformanceTier, () => applyPerformanceEnvironment(), { flush: 'post' })
watch(() => [state.value?.sessions.length || 0, sidebarCollapsed.value], async () => {
  await nextTick()
  sessionScrollbar?.update()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerup', releasePointerButtonFocus, true)
  document.removeEventListener('visibilitychange', flushHiddenBrowserState)
  if (maintenanceTimer) window.clearInterval(maintenanceTimer)
  if (performanceMonitorTimer) window.clearInterval(performanceMonitorTimer)
  if (retentionTrimTimer) window.clearTimeout(retentionTrimTimer)
  if (sessionWarmupTimer) window.clearTimeout(sessionWarmupTimer)
  if (browserPersistTimer) flushBrowserPersist()
  if (toastTimer.value) window.clearTimeout(toastTimer.value)
  sessionScrollbar?.destroy()
  sessionScrollbar = null
  liveInitialUrls.clear()
  mainFrameNavigationCounts.clear()
  document.body.classList.remove('performance-low-mode', 'performance-medium-mode', 'performance-high-mode')
  unsubscribe.forEach((dispose) => dispose())
  delete window.__starbrowserTest
})
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides" :locale="zhCN">
    <div v-if="state" class="app-shell" :class="[{ collapsed: sidebarCollapsed, maximized: isMaximized }, `performance-${effectivePerformanceTier}`]" :data-performance-tier="effectivePerformanceTier" :data-hardware-class="selectedPerformanceTier">
      <header class="titlebar">
        <div class="brand-area">
          <img class="app-logo" :src="logoUrl" alt="StarBrowser" />
          <div v-if="!sidebarCollapsed" class="brand-copy"><strong>StarBrowser</strong><span>隔离会话浏览器</span></div>
          <n-button quaternary circle class="icon-button sidebar-toggle" :aria-label="sidebarCollapsed ? '展开会话列表' : '折叠会话列表'" @click="toggleSidebar">
            <template #icon><n-icon><MenuOutline /></n-icon></template>
          </n-button>
        </div>

        <div class="tabs-area">
          <div v-if="activeSession" ref="tabList" class="tab-list" @pointermove="moveTabPointer" @pointerup="endTabPointer" @pointercancel="cancelTabPointer">
            <transition-group :key="activeSession.id" name="tab-shift">
              <div v-for="item in headerItems" :key="item.id" class="browser-tab" :class="{ 'memo-tab': item.kind === 'memo', active: item.kind === 'memo' ? activeSession.memoActive : (!activeSession.memoActive && item.tab.id === activeSession.activeTabId), 'tab-placeholder': tabDragging && item.id === tabDrag.id }" :data-tab-id="item.id" @pointerdown="beginTabPointer($event, item)" @dragstart.prevent>
                <template v-if="item.kind === 'browser'">
                  <span class="tab-icon-wrap">
                    <n-spin v-if="item.tab.loading" :size="14" />
                    <img v-else-if="item.tab.favicon" :src="item.tab.favicon" class="favicon" alt="" />
                    <n-icon v-else><GlobeOutline /></n-icon>
                  </span>
                  <span class="tab-title">{{ item.tab.title }}</span>
                  <n-button quaternary circle size="tiny" class="tab-close" @pointerdown.stop @click.stop="closeTab(item.tab)"><template #icon><n-icon><CloseOutline /></n-icon></template></n-button>
                </template>
                <template v-else>
                  <span class="tab-icon-wrap"><n-icon><DocumentTextOutline /></n-icon></span>
                  <span class="tab-title">备注</span>
                  <n-button quaternary circle size="tiny" class="tab-close" @pointerdown.stop @click.stop="hideMemo"><template #icon><n-icon><CloseOutline /></n-icon></template></n-button>
                </template>
              </div>
            </transition-group>
          </div>
          <n-button quaternary circle class="new-tab-button" data-testid="new-tab" aria-label="新建标签页" @click="newTab()"><template #icon><n-icon><AddOutline /></n-icon></template></n-button>
        </div>
        <div class="window-drag-space" title="拖动窗口；双击最大化" />
        <div class="window-controls no-drag">
          <button aria-label="最小化" @click="windowControl('minimize')"><n-icon><RemoveOutline /></n-icon></button>
          <button aria-label="最大化" @click="windowControl('maximize')"><n-icon><component :is="isMaximized ? ContractOutline : ExpandOutline" /></n-icon></button>
          <button class="window-close" aria-label="关闭" @click="windowControl('close')"><n-icon><CloseOutline /></n-icon></button>
        </div>
      </header>

      <div v-if="tabDragging && draggedHeaderItem" class="browser-tab tab-drag-preview" :class="{ 'memo-tab': draggedHeaderItem.kind === 'memo', active: draggedHeaderItem.kind === 'memo' ? activeSession?.memoActive : draggedHeaderItem.tab.id === activeSession?.activeTabId }" :style="draggedTabStyle">
        <span class="tab-icon-wrap">
          <n-icon v-if="draggedHeaderItem.kind === 'memo'"><DocumentTextOutline /></n-icon>
          <n-spin v-else-if="draggedHeaderItem.tab.loading" :size="14" />
          <img v-else-if="draggedHeaderItem.tab.favicon" :src="draggedHeaderItem.tab.favicon" class="favicon" alt="" />
          <n-icon v-else><GlobeOutline /></n-icon>
        </span>
        <span class="tab-title">{{ draggedHeaderItem.kind === 'memo' ? '备注' : draggedHeaderItem.tab.title }}</span>
        <span class="tab-preview-close"><n-icon><CloseOutline /></n-icon></span>
      </div>
      <button v-if="favoriteDragging && draggedFavorite" class="favorite-chip favorite-drag-preview" :style="draggedFavoriteStyle">
        <img v-if="draggedFavorite.favicon" :src="draggedFavorite.favicon" alt="" /><n-icon v-else><GlobeOutline /></n-icon><span>{{ draggedFavorite.title }}</span>
      </button>

      <div class="workspace">
        <aside class="sidebar">
          <n-button type="primary" class="new-session" data-testid="new-session" @click="openNewSession">
            <template #icon><n-icon><AddOutline /></n-icon></template><span v-if="!sidebarCollapsed">新建隔离会话</span>
          </n-button>
          <div v-if="!sidebarCollapsed" class="section-label">会话</div>
          <div ref="sessionList" class="session-list">
            <div v-for="session in state.sessions" :key="session.id" class="session-card" :class="{ active: session.id === activeSession?.id }" @pointerenter="scheduleSessionWarmup(session)" @pointerleave="cancelSessionWarmup(session.id)" @click="activateSession(session)">
              <template v-if="!sidebarCollapsed">
                <div class="session-title" :title="session.name">{{ session.name }}</div>
                <time>{{ formatDate(session.createdAt) }}</time>
                <div class="session-actions" @click.stop>
                  <n-button quaternary circle size="small" aria-label="打开备注" @click="showMemo(session)"><template #icon><n-icon><DocumentTextOutline /></n-icon></template></n-button>
                  <n-dropdown trigger="click" placement="bottom-end" to="body" scrollable :max-width="280" :options="sessionMenuOptions(session)" @select="(key) => handleSessionMenu(String(key), session)">
                    <n-button quaternary circle size="small" aria-label="更多操作"><template #icon><n-icon><EllipsisHorizontal /></n-icon></template></n-button>
                  </n-dropdown>
                </div>
                <div v-if="remainingDays(session) !== null || sessionPluginBadges(session).length" class="session-tags">
                  <n-tag v-for="badge in sessionPluginBadges(session)" :key="badge.key" size="small" round :type="badge.type" :title="badge.title">{{ badge.label }}</n-tag>
                  <n-tag v-if="remainingDays(session) !== null" size="small" round type="warning">剩余 {{ remainingDays(session) }} 天</n-tag>
                </div>
              </template>
              <span v-else class="session-avatar">{{ session.name.slice(0, 1).toUpperCase() }}</span>
            </div>
          </div>
          <div class="sidebar-footer">
            <template v-if="!sidebarCollapsed">
              <n-button quaternary class="footer-tool" @click="openImportSession"><template #icon><n-icon><CloudDownloadOutline /></n-icon></template>导入</n-button>
              <n-button quaternary data-testid="plugins-button" class="footer-tool" @click="openPlugins"><template #icon><n-icon><ExtensionPuzzleOutline /></n-icon></template>插件</n-button>
              <n-button quaternary data-testid="recycle-button" class="footer-tool footer-recycle" @click="openModal('recycle')"><template #icon><n-icon><TrashOutline /></n-icon></template>回收站<span v-if="state.recycleBin.length" class="footer-count">{{ state.recycleBin.length }}</span></n-button>
              <n-button quaternary data-testid="settings-button" class="footer-tool" @click="openSettings"><template #icon><n-icon><CogOutline /></n-icon></template>设置</n-button>
            </template>
            <n-dropdown v-else trigger="click" placement="top-start" to="body" scrollable :max-width="280" :options="sidebarToolOptions()" @select="(key) => handleSidebarTool(String(key))">
              <n-button quaternary class="compact footer-more" aria-label="更多工具"><template #icon><n-icon><EllipsisHorizontal /></n-icon></template></n-button>
            </n-dropdown>
          </div>
        </aside>

        <main class="main-area">
          <div class="browser-pane" :class="{ 'browser-pane-hidden': !browserVisible }">
            <div class="browser-toolbar no-drag">
              <div class="nav-actions">
                <n-button quaternary circle :disabled="!activeTab?.canGoBack" @click="browserAction('back')"><template #icon><n-icon><ArrowBackOutline /></n-icon></template></n-button>
                <n-button quaternary circle :disabled="!activeTab?.canGoForward" @click="browserAction('forward')"><template #icon><n-icon><ArrowForwardOutline /></n-icon></template></n-button>
                <n-button quaternary circle @click="browserAction(activeTab?.loading ? 'stop' : 'reload')"><template #icon><n-icon><component :is="activeTab?.loading ? StopOutline : RefreshOutline" /></n-icon></template></n-button>
              </div>
              <n-input v-model:value="address" class="address-input" round placeholder="搜索或输入网址" @keyup.enter="navigate">
                <template #prefix><n-icon><SearchOutline /></n-icon></template>
              </n-input>
              <n-button quaternary circle :type="favoriteActive ? 'primary' : 'default'" aria-label="添加或编辑收藏" @click="openQuickFavorite"><template #icon><n-icon><component :is="favoriteActive ? Star : StarOutline" /></n-icon></template></n-button>
            </div>
            <div ref="favoriteBar" class="favorites-bar no-drag" @pointermove="moveFavoritePointer" @pointerup="endFavoritePointer" @pointercancel="cancelFavoritePointer">
              <n-button text class="favorites-home" @click="() => openFavorites()"><template #icon><n-icon><BookmarksOutline /></n-icon></template>收藏夹</n-button>
              <template v-for="favorite in rootFavorites" :key="favorite.id">
                <button class="favorite-chip" :class="{ 'favorite-placeholder': favoriteDragging && favorite.id === favoriteDrag.id }" :data-favorite-id="favorite.id" :title="`${favorite.title}（右键编辑）`" @pointerdown="beginFavoritePointer($event, favorite)" @dragstart.prevent @contextmenu.prevent="quickEditFavorite(favorite)">
                  <img v-if="favorite.favicon" :src="favorite.favicon" alt="" /><n-icon v-else><GlobeOutline /></n-icon><span>{{ favorite.title }}</span>
                </button>
              </template>
            </div>
            <div class="browser-host">
              <webview
                v-for="entry in liveTabs"
                :key="entry.tab.id"
                class="browser-webview"
                :class="{ active: entry.session.id === activeSession?.id && entry.tab.id === activeTab?.id }"
                :data-tab-id="entry.tab.id"
                :data-session-id="entry.session.id"
                :src="entry.initialUrl"
                :partition="partitionFor(entry.session)"
                allowpopups
                webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes,backgroundThrottling=yes,spellcheck=no"
                @dom-ready="webviewReady"
                @did-start-navigation="webviewNavigationStarted"
                @did-start-loading="patchWebviewTab($event, { loading: true })"
                @did-stop-loading="webviewStopped"
                @did-navigate="webviewNavigated"
                @did-navigate-in-page="webviewNavigated"
                @page-title-updated="webviewTitle"
                @page-favicon-updated="webviewFavicon"
                @did-fail-load="webviewFailed"
                @render-process-gone="webviewGone"
              />
              <div v-if="activeTab && !activePageReady" class="browser-placeholder browser-warmup"><n-spin :size="26" /><strong>正在恢复 {{ activeSession?.name }}</strong><span>登录数据仍在隔离目录中，页面就绪后自动显示</span></div>
              <div v-else-if="!liveTabs.length" class="browser-placeholder"><n-spin :size="26" /><span>正在载入网页</span></div>
            </div>
          </div>
          <section v-show="!browserVisible" class="memo-page">
            <div class="memo-heading"><div><h2>{{ activeSession?.name }} · 备注</h2><p>自动保存，隐藏备注标签不会删除内容</p></div><n-button secondary @click="hideMemo"><template #icon><n-icon><CloseOutline /></n-icon></template>隐藏标签</n-button></div>
            <n-input v-if="activeSession" v-model:value="activeSession.memo" type="textarea" class="memo-editor" placeholder="在这里记录大量备注……" :autosize="false" @update:value="persist" />
          </section>
        </main>
      </div>

      <n-modal v-if="modalShown" v-model:show="modalShown" :mask-closable="modalKind !== 'close'" :close-on-esc="modalKind !== 'close'" transform-origin="center">
        <n-card class="modal-card" :class="`modal-${modalKind}`" :data-testid="modalKind ? `${modalKind}-modal` : undefined" :title="modalTitle" :bordered="false" role="dialog">
          <template #header-extra><n-button v-if="modalKind !== 'close' && !(modalKind === 'update' && updateInfo.phase === 'installing')" quaternary circle @click="closeModal"><template #icon><n-icon><CloseOutline /></n-icon></template></n-button></template>

          <div v-if="modalKind === 'session'" class="form-stack">
            <label>会话名称<n-input v-model:value="sessionDraft.name" maxlength="80" placeholder="例如：工作账号" /></label>
            <label>自动移入回收站
              <n-select v-model:value="sessionDraft.recycleMode" :options="recycleOptions" placement="top-start" to="body" />
            </label>
            <label v-if="sessionDraft.recycleMode === 'custom'">自定义天数
              <n-input-number v-model:value="sessionDraft.customRecycleDays" :min="1" :max="36500" :precision="0" :show-button="false" placeholder="输入天数"><template #suffix>天</template></n-input-number>
            </label>
            <p class="form-hint">软件启动后异步读取中国网络时间，按实际经过的自然日扣减；归零后移入回收站，进入回收站满 30 天后永久清理。</p>
            <div class="dialog-actions"><n-button @click="closeModal">取消</n-button><n-button type="primary" @click="saveSession">保存</n-button></div>
          </div>

          <div v-if="modalKind === 'favorites'" class="favorites-dialog">
            <div class="favorite-manager">
              <div class="favorite-content">
                <div class="favorite-content-header"><div><h3>收藏夹栏</h3><span>所有收藏统一放在根目录，顶部收藏标签可像网页标签一样按住拖动排序</span></div></div>
                <div class="favorite-form-grid">
                  <label>名称<n-input v-model:value="favoriteDraft.title" placeholder="收藏名称" /></label>
                  <label class="url-field">网址<n-input v-model:value="favoriteDraft.url" placeholder="https://example.com" /></label>
                  <n-button type="primary" class="save-favorite" @click="saveFavorite"><template #icon><n-icon><SaveOutline /></n-icon></template>{{ favoriteDraft.id ? '保存修改' : '添加收藏' }}</n-button>
                </div>
                <div class="favorite-list">
                  <div v-for="favorite in state.favorites" :key="favorite.id" class="favorite-row" @dblclick="openFavorite(favorite)">
                    <span class="favorite-row-icon"><img v-if="favorite.favicon" :src="favorite.favicon" alt="" /><n-icon v-else><GlobeOutline /></n-icon></span>
                    <div><strong>{{ favorite.title }}</strong><span>{{ favorite.url }}</span></div>
                    <n-button quaternary circle @click="editFavorite(favorite)"><template #icon><n-icon><CreateOutline /></n-icon></template></n-button>
                    <n-button quaternary circle type="error" @click="deleteFavorite(favorite)"><template #icon><n-icon><TrashOutline /></n-icon></template></n-button>
                  </div>
                  <n-empty v-if="!state.favorites.length" description="暂无收藏，可在上方手动添加" />
                </div>
              </div>
            </div>
          </div>

          <div v-if="modalKind === 'plugins'" class="plugin-center">
            <template v-if="!selectedPluginSettings">
              <div class="plugin-toolbar">
                <div class="plugin-tabs">
                  <button :class="{ active: pluginCenterTab === 'all' }" @click="pluginCenterTab = 'all'">全部插件</button>
                  <button :class="{ active: pluginCenterTab === 'installed' }" @click="pluginCenterTab = 'installed'">已安装 <span>{{ pluginState.installed.length }}</span></button>
                </div>
                <div class="plugin-toolbar-actions">
                  <n-button size="small" secondary :loading="pluginCenterBusy === 'import'" @click="importPlugin"><template #icon><n-icon><CloudUploadOutline /></n-icon></template>导入 JSON</n-button>
                  <n-button size="small" quaternary :loading="pluginCenterBusy === 'catalog'" @click="openPlugins"><template #icon><n-icon><SyncOutline /></n-icon></template>刷新目录</n-button>
                </div>
              </div>
              <div class="plugin-security-note"><n-icon><InformationCircleOutline /></n-icon><span>在线插件仅来自 StarBrowser 官方仓库并校验完整性；插件为受限 JSON 规则，不能执行任意代码。</span></div>

              <div v-if="pluginCenterTab === 'all'" class="plugin-list">
                <article v-for="plugin in pluginState.catalog" :key="plugin.id" class="plugin-card">
                  <span class="plugin-icon"><n-icon><component :is="pluginIcon(plugin)" /></n-icon></span>
                  <div class="plugin-card-copy"><div><strong>{{ plugin.name }}</strong><n-tag size="small" round>v{{ plugin.version }}</n-tag></div><p>{{ plugin.description }}</p><small>{{ plugin.publisher }}</small></div>
                  <div class="plugin-card-actions">
                    <n-button v-if="!installedPlugin(plugin.id)" type="primary" size="small" :loading="pluginCenterBusy === `install:${plugin.id}`" @click="installPlugin(plugin.id)">安装</n-button>
                    <n-button v-else-if="installedPlugin(plugin.id)?.updateAvailable" type="primary" size="small" :loading="pluginCenterBusy === `install:${plugin.id}`" @click="installPlugin(plugin.id)">更新至 v{{ installedPlugin(plugin.id)?.availableVersion }}</n-button>
                    <n-button v-else size="small" secondary @click="openPluginSettings(installedPlugin(plugin.id))">已安装</n-button>
                  </div>
                </article>
                <n-empty v-if="!pluginState.catalog.length" description="插件目录暂不可用，可导入符合规范的 JSON 插件" />
              </div>

              <div v-else class="plugin-list">
                <article v-for="plugin in pluginState.installed" :key="plugin.id" class="plugin-card installed">
                  <span class="plugin-icon"><n-icon><component :is="pluginIcon(plugin)" /></n-icon></span>
                  <div class="plugin-card-copy"><div><strong>{{ plugin.name }}</strong><n-tag v-if="plugin.updateAvailable" size="small" round type="success">可更新</n-tag><n-tag v-else size="small" round>v{{ plugin.version }}</n-tag></div><p>{{ plugin.description }}</p><small v-if="plugin.loadError" class="plugin-load-error">{{ plugin.loadError }}</small><small v-else>配置与运行数据由插件引擎隔离管理</small></div>
                  <div class="plugin-card-actions horizontal">
                    <n-button v-if="plugin.updateAvailable" size="small" type="primary" :loading="pluginCenterBusy === `install:${plugin.id}`" @click="installPlugin(plugin.id)">更新</n-button>
                    <n-button size="small" secondary :loading="plugin.running || pluginCenterBusy === `run:${plugin.id}`" @click="runPlugin(plugin.id)"><template #icon><n-icon><SyncOutline /></n-icon></template>立即更新</n-button>
                    <n-button size="small" @click="openPluginSettings(plugin)">设置</n-button>
                  </div>
                </article>
                <n-empty v-if="!pluginState.installed.length" description="尚未安装插件，新安装的软件默认保持纯净" />
              </div>
            </template>

            <template v-else>
              <div class="plugin-settings-head">
                <n-button quaternary circle @click="pluginSettingsId = ''"><template #icon><n-icon><ArrowBackOutline /></n-icon></template></n-button>
                <span class="plugin-icon"><n-icon><component :is="pluginIcon(selectedPluginSettings)" /></n-icon></span>
                <div><strong>{{ selectedPluginSettings.name }}</strong><span>v{{ selectedPluginSettings.version }} · {{ selectedPluginSettings.publisher }}</span></div>
                <n-button secondary :loading="selectedPluginSettings.running || pluginCenterBusy === `run:${selectedPluginSettings.id}`" @click="runPlugin(selectedPluginSettings.id)">立即更新</n-button>
              </div>
              <div class="plugin-settings-form">
                <template v-for="setting in selectedPluginSettings.settingsSchema" :key="setting.key">
                  <label v-if="settingVisible(setting)">
                    <span><strong>{{ setting.label }}</strong><small>{{ setting.description }}</small></span>
                    <n-select v-if="setting.type === 'select'" :value="selectSettingValue(setting)" :options="selectSettingOptions(setting)" placement="bottom-start" to="body" @update:value="(value) => setPluginSetting(setting, value)" />
                    <n-input-number v-else-if="setting.type === 'number'" :value="Number(pluginConfigDraft[setting.key])" :min="setting.minimum" :max="setting.maximum" :step="setting.step" :show-button="false" @update:value="(value) => setPluginSetting(setting, value)" />
                    <n-switch v-else :value="Boolean(pluginConfigDraft[setting.key])" @update:value="(value) => setPluginSetting(setting, value)" />
                  </label>
                </template>
              </div>
              <div class="plugin-uninstall-row">
                <label><span><strong>删除插件配置</strong><small>默认关闭，卸载后重新安装可继续使用原配置</small></span><n-switch v-model:value="deletePluginConfig" /></label>
                <n-popconfirm placement="top-end" to="body" negative-text="取消" positive-text="确认卸载" @positive-click="uninstallPlugin(selectedPluginSettings.id)">
                  <template #trigger><n-button type="error" secondary :loading="pluginCenterBusy === `uninstall:${selectedPluginSettings.id}`">卸载插件</n-button></template>
                  {{ deletePluginConfig ? '插件与独立配置都会删除，继续吗？' : '插件会卸载，但独立配置会保留。' }}
                </n-popconfirm>
              </div>
              <div class="dialog-actions"><n-button @click="pluginSettingsId = ''">返回</n-button><n-button type="primary" :loading="pluginCenterBusy === `settings:${selectedPluginSettings.id}`" @click="savePluginSettings">保存设置</n-button></div>
            </template>
          </div>

          <div v-if="modalKind === 'settings'" class="form-stack">
            <label>点击关闭按钮时<n-select v-model:value="settingsDraft.closeBehavior" placement="bottom-start" to="body" :options="[{ label: '每次询问', value: 'ask' }, { label: '最小化到系统托盘', value: 'tray' }, { label: '直接退出软件', value: 'exit' }]" /></label>
            <label>点击最大化按钮时<n-select v-model:value="settingsDraft.maximizeBehavior" placement="bottom-start" to="body" :options="[{ label: '窗口最大化（保留任务栏）', value: 'maximize' }, { label: '全屏显示', value: 'fullscreen' }]" /></label>
            <label>固定性能档位<n-select v-model:value="settingsDraft.performanceTier" data-testid="performance-select" placement="bottom-start" to="body" :options="performanceOptions" /></label>
            <div class="performance-summary" :class="`tier-${draftPerformanceTier}`">
              <div><span>保留会话</span><strong>{{ draftPerformancePolicy.maxLiveSessions }}</strong></div>
              <div><span>常驻标签</span><strong>{{ draftPerformancePolicy.maxLiveTabs }}</strong></div>
              <div><span>前台刷新</span><strong>{{ draftPerformancePolicy.activeFrameRate }} FPS</strong></div>
              <div><span>视觉效果</span><strong>{{ draftPerformancePolicy.effects }}</strong></div>
            </div>
            <div class="performance-runtime-status">
              <span>当前内存状态：可用 {{ memoryStatus.freeMemoryGB }} GB · StarBrowser 约 {{ memoryStatus.appWorkingSetMB }} MB</span>
              <n-tag size="small" round :type="memoryStatus.level === 'normal' ? 'success' : memoryStatus.level === 'constrained' ? 'warning' : 'error'">{{ memoryStatus.level === 'normal' ? '运行正常' : '建议关注' }}</n-tag>
            </div>
            <p class="form-hint">{{ state.settings.performanceSelectionSource === 'automatic' ? '首次启动已自动评估' : '当前档位由用户手动固定' }}：约 {{ machineProfile.totalMemoryGB }} GB 内存、{{ machineProfile.logicalCpuCount }} 个逻辑处理器、平均 {{ machineProfile.averageCpuMHz }} MHz，当前选择{{ hardwareClassLabels[settingsDraft.performanceTier] }}档。</p>
            <p class="form-hint">切换前会按鼠标停留意图预热页面，切换完成后延迟 {{ releaseDelayLabel(draftPerformancePolicy.releaseDelayMs) }} 清理超额页面。后续检测到持续性能不足时只会给出推荐，软件不会自行改变当前固定档位。</p>
            <p class="form-hint">被释放的页面再次切换时会重新载入，但 Cookie、本地存储、IndexedDB 与登录信息仍保存在隔离数据目录，不会因此删除。</p>
            <div class="settings-update-card">
              <span class="settings-update-icon"><n-icon><RocketOutline /></n-icon></span>
              <div><strong>StarBrowser v{{ updateInfo.currentVersion || '1.8.0' }}</strong><small>启动时会在后台检查更新；喜欢这个项目，可以去 GitHub 点个 Star。</small></div>
              <n-button size="small" secondary @click="openGithubProject"><template #icon><n-icon><StarOutline /></n-icon></template>GitHub</n-button>
              <n-button size="small" type="primary" :loading="updateInfo.phase === 'checking'" @click="checkForUpdatesManually">检查更新</n-button>
            </div>
            <div class="dialog-actions"><n-button @click="closeModal">取消</n-button><n-button type="primary" @click="saveSettings">保存设置</n-button></div>
          </div>

          <div v-if="modalKind === 'transfer'" class="transfer-dialog">
            <div class="transfer-summary"><n-icon :size="28" color="#635bff"><component :is="transferMode === 'export' ? CloudUploadOutline : CloudDownloadOutline" /></n-icon><div><strong>{{ transferMode === 'export' ? '导出当前隔离会话' : '从会话包创建新会话' }}</strong><span>包含会话标签、Cookie、Local Storage、Session Storage 与 IndexedDB；不包含收藏夹、网页缓存或网页快照。</span></div></div>
            <label>加密密码<n-input v-model:value="transferDraft.password" type="password" show-password-on="mousedown" placeholder="至少 8 个字符" @keyup.enter="submitSessionTransfer" /></label>
            <label v-if="transferMode === 'export'">再次输入密码<n-input v-model:value="transferDraft.confirmation" type="password" show-password-on="mousedown" placeholder="确认导出密码" @keyup.enter="submitSessionTransfer" /></label>
            <p class="transfer-version">StarBrowser 会话包格式 v1 · AES-256-GCM · 加密算法 v1。密码无法找回，只有支持相同格式与算法版本的软件才能导入。</p>
            <div class="dialog-actions"><n-button :disabled="transferDraft.busy" @click="closeModal">取消</n-button><n-button type="primary" :loading="transferDraft.busy" @click="submitSessionTransfer">{{ transferMode === 'export' ? '选择位置并导出' : '选择文件并导入' }}</n-button></div>
          </div>

          <div v-if="modalKind === 'recycle'" class="recycle-dialog">
            <n-empty v-if="!state.recycleBin.length" description="回收站为空" />
            <div v-for="(item, index) in state.recycleBin" :key="item.session.id" class="recycle-row">
              <div><strong>{{ item.session.name }}</strong><span>删除于 {{ formatTime(item.deletedAt) }}</span></div>
              <n-button @click="restoreSession(index)">恢复</n-button>
              <n-popconfirm placement="top-end" to="body" scrollable :max-width="320" negative-text="取消" positive-text="确认删除" @positive-click="permanentlyDelete(index)"><template #trigger><n-button type="error" secondary>永久删除</n-button></template>此操作无法撤销，继续吗？</n-popconfirm>
            </div>
          </div>

          <div v-if="modalKind === 'update'" class="update-dialog" data-testid="update-content">
            <div class="update-hero">
              <span class="update-hero-icon"><n-icon><component :is="updateInfo.phase === 'downloaded' ? CheckmarkCircleOutline : CloudDownloadOutline" /></n-icon></span>
              <div>
                <n-tag round size="small" type="info">v{{ updateInfo.currentVersion }} → v{{ updateInfo.candidate?.version || updateInfo.currentVersion }}</n-tag>
                <h3>{{ updateInfo.phase === 'downloaded' ? '更新已准备完成' : updateInfo.candidate?.name || 'StarBrowser 更新' }}</h3>
                <p v-if="updateInfo.phase === 'available'">先在后台完整下载并校验，下载完成后由你决定何时重启更新。</p>
                <p v-else-if="updateInfo.phase === 'downloading'">正在后台下载，网页和视频可以继续使用。</p>
                <p v-else-if="updateInfo.phase === 'extracting'">下载完成，正在校验和准备更新文件。</p>
                <p v-else-if="updateInfo.phase === 'downloaded'">重启后原地替换程序；data、会话登录状态与用户文件不会被覆盖。</p>
                <p v-else-if="updateInfo.phase === 'installing'">正在安全保存数据并启动更新程序……</p>
                <p v-else-if="updateInfo.phase === 'error'">更新没有应用，当前程序和数据保持不变。</p>
              </div>
            </div>
            <div v-if="['downloading', 'extracting', 'downloaded', 'installing'].includes(updateInfo.phase)" class="update-progress-block">
              <n-progress type="line" :percentage="Math.round(updateInfo.progress)" :height="9" :border-radius="9" :indicator-placement="'inside'" processing />
              <div><span>{{ updateInfo.phase === 'extracting' ? '正在准备文件' : updateInfo.phase === 'installing' ? '准备重启' : `${formatUpdateBytes(updateInfo.transferred)} / ${formatUpdateBytes(updateInfo.total)}` }}</span><span v-if="updateInfo.speed > 0">{{ formatUpdateBytes(updateInfo.speed) }}/s</span></div>
            </div>
            <div v-if="updateInfo.error" class="update-error"><n-icon><InformationCircleOutline /></n-icon><span>{{ updateInfo.error }}</span></div>
            <div v-if="updateInfo.candidate?.notes" class="update-notes"><strong>本次更新</strong><p>{{ updateInfo.candidate.notes }}</p></div>
            <div class="update-safety">
              <span>SHA-256 完整性校验</span><span>data 永不覆盖</span><span>启动失败自动回滚</span><span>兼容迁移清单</span>
            </div>
            <div class="dialog-actions update-actions">
              <n-button quaternary @click="openGithubProject"><template #icon><n-icon><OpenOutline /></n-icon></template>查看项目</n-button>
              <template v-if="updateInfo.phase === 'available'">
                <n-button @click="ignoreAvailableUpdate">忽略此版本</n-button><n-button @click="closeModal">稍后</n-button><n-button type="primary" @click="downloadAvailableUpdate">下载更新</n-button>
              </template>
              <template v-else-if="updateInfo.phase === 'downloading' || updateInfo.phase === 'extracting'">
                <n-button @click="closeModal">转到后台</n-button>
              </template>
              <template v-else-if="updateInfo.phase === 'downloaded'">
                <n-button @click="closeModal">稍后重启</n-button><n-button type="primary" @click="installAvailableUpdate">重启并更新</n-button>
              </template>
              <template v-else-if="updateInfo.phase === 'error'">
                <n-button @click="closeModal">关闭</n-button><n-button type="primary" @click="updateInfo.candidate ? downloadAvailableUpdate() : checkForUpdatesManually()">重试</n-button>
              </template>
            </div>
          </div>

          <div v-if="modalKind === 'close'" class="close-dialog">
            <div class="close-message"><n-icon :size="28" color="#635bff"><InformationCircleOutline /></n-icon><div><strong>关闭窗口后要做什么？</strong><span>可以退出软件，也可以保留在系统托盘。</span></div></div>
            <label class="remember-close-row"><span><strong>记住我的选择</strong><small>以后点击关闭按钮时直接执行该操作</small></span><n-switch v-model:value="rememberClose" /></label>
            <div class="dialog-actions"><n-button @click="closeModal">取消</n-button><n-button @click="closeChoice('tray')">最小化到托盘</n-button><n-button type="error" @click="closeChoice('exit')">退出软件</n-button></div>
          </div>
        </n-card>
      </n-modal>

      <transition name="advice">
        <div v-if="performanceAdvice" class="performance-advice" data-testid="performance-advice">
          <div><strong>建议切换到{{ hardwareClassLabels[performanceAdvice.recommended] }}档</strong><span>{{ performanceAdvice.reason }}，当前固定档位不会自动改变。</span></div>
          <n-button size="small" @click="dismissPerformanceAdvice">暂不</n-button>
          <n-button size="small" type="primary" @click="applyPerformanceRecommendation">切换</n-button>
        </div>
      </transition>
      <transition name="toast"><div v-if="toast" class="toast">{{ toast }}</div></transition>
    </div>
  </n-config-provider>
</template>
