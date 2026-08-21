import { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, clipboard, shell, webContents, dialog, net } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import dgram from 'node:dgram'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { secureExtractZip } from './secure-extract.mjs'
import { PluginService } from './plugin-service.mjs'
import { removeUpdateTree, updateFs, updateFsp } from './update-filesystem.mjs'
import {
  APP_COMPATIBILITY, UPDATE_API_URL, UPDATE_REPOSITORY, buildApplyUpdatePowerShell, buildUpdateUiPowerShell,
  legacyProgramManifest, parseProgramManifest, parseReleaseCandidate, safeVersion,
} from './update-service.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const smokeMode = process.env.STARBROWSER_SMOKE === '1'
const captureMode = process.env.STARBROWSER_CAPTURE === '1'
const updateIntegrationMode = process.env.STARBROWSER_UPDATE_INTEGRATION === '1'
const captureDir = process.env.STARBROWSER_CAPTURE_DIR ? path.resolve(process.env.STARBROWSER_CAPTURE_DIR) : ''
const legacyCookieImportFile = process.env.STARBROWSER_LEGACY_COOKIE_IMPORT_FILE
  ? path.resolve(process.env.STARBROWSER_LEGACY_COOKIE_IMPORT_FILE)
  : ''
const legacyCookieImportReport = process.env.STARBROWSER_LEGACY_COOKIE_IMPORT_REPORT
  ? path.resolve(process.env.STARBROWSER_LEGACY_COOKIE_IMPORT_REPORT)
  : ''
const portableRoot = process.env.STARBROWSER_TEST_ROOT
  ? path.resolve(process.env.STARBROWSER_TEST_ROOT)
  : process.env.PORTABLE_EXECUTABLE_DIR
  ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
  : app.isPackaged
    ? path.dirname(process.execPath)
    : projectRoot
const dataRoot = path.join(portableRoot, 'data')
const electronDataRoot = path.join(dataRoot, 'electron')
const stateFile = path.join(dataRoot, 'state.json')
const stateBackupFile = path.join(dataRoot, 'state.backup.json')
const transferWorkerPath = path.join(__dirname, 'session-transfer-worker.mjs')
const compatibilityFile = path.join(dataRoot, 'compatibility.json')
const updatesBaseRoot = path.join(dataRoot, 'updates')
const updateFailureFile = path.join(dataRoot, 'update-error.log')
const updateCleanupFile = path.join(dataRoot, 'update-cleanup-pending.log')
const updateProgressFile = path.join(dataRoot, 'update-progress.json')
const postUpdateToken = (process.argv.find((argument) => argument.startsWith('--post-update-token=')) || '').split('=')[1] || ''
const postUpdateVersion = (process.argv.find((argument) => argument.startsWith('--post-update-version=')) || '').split('=')[1] || ''

fs.mkdirSync(electronDataRoot, { recursive: true })
app.setPath('userData', electronDataRoot)
app.setPath('sessionData', path.join(electronDataRoot, 'session-data'))
app.setAppUserModelId('com.starbrowser.desktop')

const iconPath = path.join(projectRoot, 'assets', 'starbrowser.ico')
const configuredPartitions = new Set()
const configuredGuestIds = new Set()
let mainWindow = null
let tray = null
let state = null
let stateDirty = false
let savePromise = Promise.resolve()
let quitting = false
let quitPrepared = false
let updateStatus = { phase: 'idle', currentVersion: app.getVersion(), progress: 0 }
let updateCandidate = null
let downloadedUpdate = null
let updateWork = null
let pluginService = null
let staleUpdateCleanup = Promise.resolve()

const PERFORMANCE_POLICIES = {
  low: { activeFrameRate: 30, backgroundFrameRate: 2 },
  medium: { activeFrameRate: 50, backgroundFrameRate: 6 },
  high: { activeFrameRate: 60, backgroundFrameRate: 16 },
}

function detectPerformanceProfile() {
  const totalMemoryGB = Math.max(1, Math.round((os.totalmem() / 1024 ** 3) * 10) / 10)
  const cpuInfo = os.cpus() || []
  const logicalCpuCount = Math.max(1, cpuInfo.length || 1)
  const averageCpuMHz = Math.max(500, Math.round(cpuInfo.reduce((total, cpu) => total + (Number(cpu.speed) || 0), 0) / Math.max(1, cpuInfo.length)) || 2500)
  const memoryScore = totalMemoryGB <= 4 ? 0 : totalMemoryGB <= 8 ? 1 : totalMemoryGB <= 16 ? 2 : totalMemoryGB <= 32 ? 3 : 4
  const cpuCapacity = logicalCpuCount * Math.max(.55, Math.min(1.4, averageCpuMHz / 3000))
  const cpuScore = cpuCapacity <= 3 ? 0 : cpuCapacity <= 6 ? 1 : cpuCapacity <= 12 ? 2 : cpuCapacity <= 24 ? 3 : 4
  const hardwareScore = Math.round((memoryScore * .62 + cpuScore * .38) * 100) / 100
  const hardwareClass = hardwareScore < .75
    ? 'ultra-low'
    : hardwareScore < 1.6
      ? 'low'
      : hardwareScore < 2.6
        ? 'balanced'
        : hardwareScore < 3.5
          ? 'high'
          : 'ultra-high'
  const tier = hardwareClass === 'ultra-low' || hardwareClass === 'low' ? 'low' : hardwareClass === 'balanced' ? 'medium' : 'high'
  return { tier, hardwareClass, hardwareScore, totalMemoryGB, logicalCpuCount, averageCpuMHz }
}

function getMemoryStatus() {
  if (smokeMode) return { level: 'normal', freeMemoryGB: 8, usedPercent: 50, appWorkingSetMB: 256 }
  const totalBytes = Math.max(1, os.totalmem())
  const freeBytes = Math.max(0, os.freemem())
  const freeMemoryGB = Math.round((freeBytes / 1024 ** 3) * 10) / 10
  const usedPercent = Math.round((1 - freeBytes / totalBytes) * 1000) / 10
  const appWorkingSetMB = Math.round(app.getAppMetrics().reduce((total, metric) => total + (Number(metric.memory?.workingSetSize) || 0), 0) / 1024)
  const totalMemoryGB = totalBytes / 1024 ** 3
  const criticalFloor = Math.max(.65, Math.min(2, totalMemoryGB * .07))
  const constrainedFloor = Math.max(1.25, Math.min(4, totalMemoryGB * .14))
  const level = freeMemoryGB <= criticalFloor || usedPercent >= 94
    ? 'critical'
    : freeMemoryGB <= constrainedFloor || usedPercent >= 86
      ? 'constrained'
      : 'normal'
  return { level, freeMemoryGB, usedPercent, appWorkingSetMB }
}

function effectivePerformanceTier() {
  const selected = state?.settings?.performanceTier
  if (selected === 'ultra-low' || selected === 'low') return 'low'
  if (selected === 'balanced') return 'medium'
  if (selected === 'high' || selected === 'ultra-high') return 'high'
  return detectPerformanceProfile().tier
}

function applyGuestPerformance(payload = {}) {
  const policy = PERFORMANCE_POLICIES[effectivePerformanceTier()] || PERFORMANCE_POLICIES.medium
  const guestIds = new Set(Array.isArray(payload.guestIds) ? payload.guestIds.map(Number).filter(Number.isFinite) : [])
  const activeGuestId = Number(payload.activeGuestId) || 0
  let activeFrameRate = Math.max(15, Math.min(60, Number(payload.activeFrameRate) || policy.activeFrameRate))
  let backgroundFrameRate = Math.max(1, Math.min(30, Number(payload.backgroundFrameRate) || policy.backgroundFrameRate))
  for (const contents of webContents.getAllWebContents()) {
    if (contents.getType() !== 'webview' || contents.isDestroyed()) continue
    const id = contents.id
    if (guestIds.size && !guestIds.has(id)) continue
    try {
      if (!smokeMode) contents.setBackgroundThrottling(true)
      contents.setFrameRate(id === activeGuestId ? activeFrameRate : backgroundFrameRate)
    } catch {
      // A guest can disappear while a retention update is being applied.
    }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function showWebContextMenu(contents, params) {
  if (!mainWindow || mainWindow.isDestroyed() || contents.isDestroyed()) return
  const history = contents.navigationHistory
  const items = []
  if (params.linkURL) {
    items.push(
      { label: '在新标签页中打开链接', click: () => send('browser:new-window', { url: params.linkURL }) },
      { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    )
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: '在新标签页中打开图片', click: () => send('browser:new-window', { url: params.srcURL }) },
      { label: '复制图片', click: () => contents.copyImageAt(params.x, params.y) },
      { label: '复制图片地址', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' },
    )
  }
  if (params.isEditable) {
    items.push(
      { label: '撤销', enabled: params.editFlags.canUndo, click: () => contents.undo() },
      { label: '重做', enabled: params.editFlags.canRedo, click: () => contents.redo() },
      { type: 'separator' },
      { label: '剪切', enabled: params.editFlags.canCut, click: () => contents.cut() },
      { label: '复制', enabled: params.editFlags.canCopy, click: () => contents.copy() },
      { label: '粘贴', enabled: params.editFlags.canPaste, click: () => contents.paste() },
      { label: '全选', click: () => contents.selectAll() },
      { type: 'separator' },
    )
  } else if (params.selectionText) {
    items.push(
      { label: '复制', click: () => contents.copy() },
      { label: '使用必应搜索所选内容', click: () => send('browser:new-window', { url: `https://www.bing.com/search?q=${encodeURIComponent(params.selectionText)}` }) },
      { type: 'separator' },
    )
  }
  items.push(
    { label: '后退', enabled: Boolean(history?.canGoBack()), click: () => history?.goBack() },
    { label: '前进', enabled: Boolean(history?.canGoForward()), click: () => history?.goForward() },
    { label: '重新加载', click: () => contents.reload() },
    { type: 'separator' },
    { label: '复制网页地址', click: () => clipboard.writeText(contents.getURL()) },
  )
  Menu.buildFromTemplate(items).popup({ window: mainWindow })
}

function showRendererContextMenu(contents, params) {
  if (!mainWindow || mainWindow.isDestroyed() || contents.isDestroyed()) return
  const items = []
  if (params.isEditable) {
    items.push(
      { label: '撤销', enabled: params.editFlags.canUndo, click: () => contents.undo() },
      { label: '重做', enabled: params.editFlags.canRedo, click: () => contents.redo() },
      { type: 'separator' },
      { label: '剪切', enabled: params.editFlags.canCut, click: () => contents.cut() },
      { label: '复制', enabled: params.editFlags.canCopy, click: () => contents.copy() },
      { label: '粘贴', enabled: params.editFlags.canPaste, click: () => contents.paste() },
      { label: '全选', click: () => contents.selectAll() },
    )
  } else if (params.selectionText) {
    items.push({ label: '复制', click: () => contents.copy() })
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow })
}

function id() {
  return crypto.randomUUID().replaceAll('-', '')
}

function optionalInteger(value, minimum) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? Math.floor(number) : null
}

function runTransferWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(transferWorkerPath, { workerData })
    let outcome = null
    let workerError = null
    worker.once('message', (message) => { outcome = message })
    worker.once('error', (error) => { workerError = error })
    worker.once('exit', (code) => {
      if (workerError) return reject(workerError)
      if (code !== 0) return reject(new Error(`会话包后台任务异常退出：${code}`))
      if (outcome?.ok) return resolve(outcome.result)
      const error = new Error(outcome?.error?.message || '会话包处理失败')
      error.code = outcome?.error?.code || 'TRANSFER_FAILED'
      reject(error)
    })
  })
}

function exportableSession(current) {
  return {
    name: current.name,
    memo: current.memo,
    memoTabVisible: current.memoTabVisible,
    memoTabIndex: current.memoTabIndex,
    memoActive: current.memoActive,
    createdAt: current.createdAt,
    expiresAt: null,
    recycleAfterDays: current.recycleAfterDays,
    recycleDaysRemaining: current.recycleDaysRemaining,
    recycleLastCheckedDate: current.recycleLastCheckedDate,
    activeTabId: current.activeTabId,
    tabs: current.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favicon: tab.favicon,
      createdAt: tab.createdAt,
    })),
  }
}

function importedSession(payload) {
  const sourceTabs = Array.isArray(payload?.tabs) && payload.tabs.length ? payload.tabs : [createTab()]
  const tabIdMap = new Map()
  const tabs = sourceTabs.map((tab) => {
    const next = createTab(/^https?:\/\//i.test(tab?.url || '') ? tab.url : 'https://www.bing.com/')
    tabIdMap.set(tab?.id, next.id)
    next.title = String(tab?.title || '新标签页').slice(0, 500)
    next.favicon = typeof tab?.favicon === 'string' ? tab.favicon : ''
    next.createdAt = typeof tab?.createdAt === 'string' ? tab.createdAt : next.createdAt
    return next
  })
  return {
    id: id(),
    profileName: `session_${id()}`,
    name: String(payload?.name || '导入的会话').slice(0, 80),
    memo: typeof payload?.memo === 'string' ? payload.memo : '',
    memoTabVisible: Boolean(payload?.memoTabVisible),
    memoTabIndex: Math.max(0, Math.min(tabs.length, Number(payload?.memoTabIndex ?? tabs.length))),
    memoActive: Boolean(payload?.memoActive),
    createdAt: new Date().toISOString(),
    expiresAt: null,
    recycleAfterDays: optionalInteger(payload?.recycleAfterDays, 1),
    recycleDaysRemaining: optionalInteger(payload?.recycleDaysRemaining, 0),
    recycleLastCheckedDate: typeof payload?.recycleLastCheckedDate === 'string' ? payload.recycleLastCheckedDate : null,
    activeTabId: tabIdMap.get(payload?.activeTabId) || tabs[0].id,
    tabs,
  }
}

function cookieImportDetails(cookie) {
  const domain = String(cookie?.domain || '').replace(/^\./, '')
  if (!domain || !cookie?.name) return null
  const details = {
    url: `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`,
    name: String(cookie.name),
    value: String(cookie.value || ''),
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  }
  if (!cookie.hostOnly) details.domain = cookie.domain
  if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite
  if (!cookie.session && Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate
  return details
}

async function importCookies(ses, cookies) {
  const list = Array.isArray(cookies) ? cookies : []
  for (let index = 0; index < list.length; index += 24) {
    await Promise.allSettled(list.slice(index, index + 24).map((cookie) => {
      const details = cookieImportDetails(cookie)
      return details ? ses.cookies.set(details) : Promise.resolve()
    }))
  }
  await ses.flushStorageData()
}

async function importLegacyCookies() {
  const report = { ok: false, sessions: 0, sourceCookies: 0, importedCookies: 0, acceptedCookies: 0, rejectedCookies: 0, error: '' }
  try {
    const payload = JSON.parse(await fsp.readFile(legacyCookieImportFile, 'utf8'))
    const entries = Array.isArray(payload?.sessions) ? payload.sessions : []
    const knownIds = new Set(state.sessions.map((item) => item.id))
    for (const entry of entries) {
      if (!knownIds.has(entry?.id)) continue
      const ses = configureSession(entry.id)
      await ses.clearStorageData({ storages: ['cookies'] })
      const cookies = Array.isArray(entry.cookies) ? entry.cookies : []
      report.sessions += 1
      report.sourceCookies += cookies.length
      for (let index = 0; index < cookies.length; index += 24) {
        const results = await Promise.allSettled(cookies.slice(index, index + 24).map((cookie) => {
          const details = cookieImportDetails(cookie)
          if (!details) return Promise.reject(new Error('Invalid cookie'))
          return ses.cookies.set(details)
        }))
        for (const result of results) {
          if (result.status === 'fulfilled') report.importedCookies += 1
          else report.rejectedCookies += 1
        }
      }
      await ses.cookies.flushStore()
      report.acceptedCookies += (await ses.cookies.get({})).length
    }
    report.ok = report.sessions > 0 && report.acceptedCookies > 0
  } catch (error) {
    report.error = error?.message || String(error)
  } finally {
    await fsp.rm(legacyCookieImportFile, { force: true }).catch(() => {})
    if (legacyCookieImportReport) {
      await fsp.mkdir(path.dirname(legacyCookieImportReport), { recursive: true })
      await fsp.writeFile(legacyCookieImportReport, JSON.stringify(report, null, 2), 'utf8')
    }
  }
  return report
}

async function exportSessionArchive(sessionId, password) {
  const current = state?.sessions?.find((item) => item.id === sessionId)
  if (!current) return { ok: false, error: '找不到需要导出的会话' }
  if (typeof password !== 'string' || password.length < 8) return { ok: false, error: '导出密码至少需要 8 个字符' }
  const safeName = current.name.replace(/[\\/:*?"<>|]/g, '_').trim() || '会话'
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: '导出加密会话',
    defaultPath: path.join(portableRoot, `${safeName}.sbsession`),
    filters: [{ name: 'StarBrowser 加密会话包', extensions: ['sbsession'] }],
  })
  if (selection.canceled || !selection.filePath) return { ok: false, canceled: true }
  try {
    const ses = configureSession(current.id)
    await ses.flushStorageData()
    const storagePath = ses.getStoragePath()
    if (!storagePath) return { ok: false, error: '无法读取会话存储目录' }
    const cookies = await ses.cookies.get({})
    const stats = await runTransferWorker({ operation: 'export', archivePath: selection.filePath, storagePath, password, session: exportableSession(current), cookies })
    return { ok: true, filePath: selection.filePath, stats }
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: error?.code }
  }
}

async function importSessionArchive(password) {
  if (typeof password !== 'string' || password.length < 8) return { ok: false, error: '导入密码至少需要 8 个字符' }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '导入加密会话',
    properties: ['openFile'],
    filters: [{ name: 'StarBrowser 加密会话包', extensions: ['sbsession'] }],
  })
  if (selection.canceled || !selection.filePaths[0]) return { ok: false, canceled: true }
  const targetId = id()
  const targetSession = configureSession(targetId)
  try {
    await targetSession.clearStorageData()
    const storagePath = targetSession.getStoragePath()
    if (!storagePath) return { ok: false, error: '无法创建会话存储目录' }
    const result = await runTransferWorker({ operation: 'import', archivePath: selection.filePaths[0], storagePath, password })
    await importCookies(targetSession, result.payload.cookies)
    const nextSession = importedSession(result.payload.session)
    nextSession.id = targetId
    nextSession.profileName = `session_${targetId}`
    return { ok: true, session: nextSession, stats: { storageBytes: result.storageBytes, fileCount: result.fileCount, cookieCount: result.payload.cookies?.length || 0, formatVersion: result.formatVersion, algorithmVersion: result.algorithmVersion } }
  } catch (error) {
    await Promise.allSettled([targetSession.clearStorageData(), targetSession.clearCache()])
    return { ok: false, error: error?.message || String(error), code: error?.code }
  }
}

function createTab(url = 'https://www.bing.com/') {
  return {
    id: id(),
    title: '新标签页',
    url,
    favicon: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: new Date().toISOString(),
  }
}

function createSession(name = '默认会话') {
  const tab = createTab()
  return {
    id: id(),
    profileName: `session_${id()}`,
    name,
    memo: '',
    memoTabVisible: false,
    memoTabIndex: 1,
    memoActive: false,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    recycleAfterDays: null,
    recycleDaysRemaining: null,
    recycleLastCheckedDate: null,
    activeTabId: tab.id,
    tabs: [tab],
  }
}

function createDefaultState() {
  const first = createSession()
  const detected = detectPerformanceProfile()
  return {
    version: 1,
    activeSessionId: first.id,
    sessions: [first],
    recycleBin: [],
    favorites: [],
    favoriteFolders: [],
    settings: {
      closeBehavior: 'ask',
      maximizeBehavior: 'maximize',
      sidebarCollapsed: false,
      performanceTier: detected.hardwareClass,
      performanceSelectionSource: 'automatic',
      ignoredUpdateVersion: '',
    },
  }
}

function normalizeState(candidate) {
  const base = candidate && typeof candidate === 'object' ? candidate : createDefaultState()
  const schemaVersion = Math.max(1, Number(base.version) || 1)
  if (schemaVersion > APP_COMPATIBILITY.stateSchemaVersion) {
    throw new Error(`数据结构版本 ${schemaVersion} 高于当前程序支持的 ${APP_COMPATIBILITY.stateSchemaVersion}，已停止写入以保护数据`)
  }
  base.version = APP_COMPATIBILITY.stateSchemaVersion
  const detected = detectPerformanceProfile()
  const existingSettings = base.settings && typeof base.settings === 'object' ? base.settings : {}
  const validHardwareClasses = ['ultra-low', 'low', 'balanced', 'high', 'ultra-high']
  let performanceTier = validHardwareClasses.includes(existingSettings.performanceTier) ? existingSettings.performanceTier : ''
  if (!performanceTier && existingSettings.performanceMode === 'auto') {
    performanceTier = validHardwareClasses.includes(existingSettings.autoHardwareClass) ? existingSettings.autoHardwareClass : detected.hardwareClass
  }
  if (!performanceTier && existingSettings.performanceMode === 'low') performanceTier = 'low'
  if (!performanceTier && existingSettings.performanceMode === 'medium') performanceTier = 'balanced'
  if (!performanceTier && existingSettings.performanceMode === 'high') performanceTier = 'high'
  performanceTier ||= detected.hardwareClass
  const performanceSelectionSource = ['automatic', 'manual'].includes(existingSettings.performanceSelectionSource)
    ? existingSettings.performanceSelectionSource
    : existingSettings.performanceMode && existingSettings.performanceMode !== 'auto'
      ? 'manual'
      : 'automatic'
  base.sessions = Array.isArray(base.sessions) ? base.sessions : []
  base.recycleBin = Array.isArray(base.recycleBin) ? base.recycleBin : []
  base.favorites = Array.isArray(base.favorites) ? base.favorites : []
  base.favoriteFolders = Array.isArray(base.favoriteFolders) ? base.favoriteFolders : []
  base.settings = {
    closeBehavior: ['ask', 'tray', 'exit'].includes(base.settings?.closeBehavior) ? base.settings.closeBehavior : 'ask',
    maximizeBehavior: ['maximize', 'fullscreen'].includes(base.settings?.maximizeBehavior) ? base.settings.maximizeBehavior : 'maximize',
    sidebarCollapsed: Boolean(base.settings?.sidebarCollapsed),
    performanceTier,
    performanceSelectionSource,
    ignoredUpdateVersion: typeof existingSettings.ignoredUpdateVersion === 'string' ? existingSettings.ignoredUpdateVersion : '',
  }
  for (const current of base.sessions) {
    current.id ||= id()
    current.profileName ||= `session_${id()}`
    current.name ||= '未命名会话'
    current.memo ||= ''
    current.memoTabVisible = Boolean(current.memoTabVisible)
    current.memoTabIndex = Math.max(0, Math.min(current.tabs?.length || 0, Number(current.memoTabIndex ?? current.tabs?.length ?? 0)))
    current.memoActive = Boolean(current.memoActive)
    current.createdAt ||= new Date().toISOString()
    delete current.availableAt
    current.recycleAfterDays = optionalInteger(current.recycleAfterDays, 1)
    current.recycleDaysRemaining = optionalInteger(current.recycleDaysRemaining, 0) ?? current.recycleAfterDays
    current.recycleLastCheckedDate = typeof current.recycleLastCheckedDate === 'string' ? current.recycleLastCheckedDate : null
    current.tabs = Array.isArray(current.tabs) ? current.tabs : []
    if (!current.tabs.length) current.tabs.push(createTab())
    for (const tab of current.tabs) {
      tab.id ||= id()
      tab.url ||= 'https://www.bing.com/'
      tab.title ||= '新标签页'
      tab.favicon ||= ''
      tab.loading = false
      tab.canGoBack = false
      tab.canGoForward = false
      tab.createdAt ||= new Date().toISOString()
    }
    if (!current.tabs.some((tab) => tab.id === current.activeTabId)) current.activeTabId = current.tabs[0].id
  }
  base.favoriteFolders = []
  for (const favorite of base.favorites) {
    favorite.id ||= id()
    favorite.title ||= '未命名收藏'
    favorite.url ||= 'https://www.bing.com/'
    favorite.favicon ||= ''
    favorite.folderId = ''
    favorite.createdAt ||= new Date().toISOString()
  }
  if (!base.sessions.length) base.sessions.push(createSession())
  if (!base.sessions.some((item) => item.id === base.activeSessionId)) base.activeSessionId = base.sessions[0].id
  return base
}

async function loadState() {
  const errors = []
  let existingCopies = 0
  for (const candidate of [stateFile, stateBackupFile]) {
    try {
      if (fs.existsSync(candidate)) existingCopies += 1
      const text = await fsp.readFile(candidate, 'utf8')
      return normalizeState(JSON.parse(text))
    } catch (error) {
      errors.push(error)
      // Try the next copy.
    }
  }
  if (existingCopies > 0) {
    const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join('；')
    throw new Error(`状态文件与备份均无法安全读取：${details}`)
  }
  return createDefaultState()
}

async function saveStateNow() {
  if (!state || !stateDirty) return
  const snapshot = JSON.stringify(state, null, 2)
  stateDirty = false
  savePromise = savePromise.then(async () => {
    await fsp.mkdir(dataRoot, { recursive: true })
    const temporary = `${stateFile}.${process.pid}.tmp`
    await fsp.writeFile(temporary, snapshot, 'utf8')
    try {
      await fsp.copyFile(stateFile, stateBackupFile)
    } catch {
      // The first save has no previous state file.
    }
    await fsp.rename(temporary, stateFile)
  }).catch((error) => {
    stateDirty = true
    console.error('Failed to save state', error)
  })
  await savePromise
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function publicUpdateStatus() {
  return {
    phase: updateStatus.phase,
    currentVersion: app.getVersion(),
    progress: Number(updateStatus.progress) || 0,
    transferred: Number(updateStatus.transferred) || 0,
    total: Number(updateStatus.total) || updateCandidate?.asset?.size || 0,
    speed: Number(updateStatus.speed) || 0,
    error: String(updateStatus.error || ''),
    manual: Boolean(updateStatus.manual),
    candidate: updateCandidate ? {
      version: updateCandidate.version,
      name: updateCandidate.name,
      notes: updateCandidate.notes,
      publishedAt: updateCandidate.publishedAt,
      releaseUrl: updateCandidate.releaseUrl,
      size: updateCandidate.asset.size,
      compatibility: updateCandidate.compatibility,
    } : null,
  }
}

function setUpdateStatus(next) {
  updateStatus = { ...updateStatus, ...next, currentVersion: app.getVersion() }
  send('update:status', publicUpdateStatus())
  return publicUpdateStatus()
}

async function fetchJson(url) {
  const response = await net.fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `StarBrowser/${app.getVersion()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(response.status === 404 ? '暂未发布可用版本' : `更新服务返回 ${response.status}`)
  return response.json()
}

async function checkForUpdates({ manual = false } = {}) {
  if (updateWork) return publicUpdateStatus()
  if (!app.isPackaged && !smokeMode) return setUpdateStatus({ phase: 'unsupported', manual, error: '开发模式不执行自动更新' })
  if (manual) await updateFsp.rm(updateFailureFile, { force: true }).catch(() => {})
  setUpdateStatus({ phase: 'checking', manual, progress: 0, error: '' })
  try {
    const release = await fetchJson(UPDATE_API_URL)
    const manifestAsset = Array.isArray(release.assets) ? release.assets.find((asset) => asset?.name === 'latest.json') : null
    const manifest = manifestAsset?.browser_download_url ? await fetchJson(manifestAsset.browser_download_url) : { version: release.tag_name }
    const ignoredVersion = manual ? '' : state?.settings?.ignoredUpdateVersion || ''
    const candidate = parseReleaseCandidate(release, manifest, app.getVersion(), ignoredVersion)
    if (!candidate) {
      updateCandidate = null
      downloadedUpdate = null
      return setUpdateStatus({ phase: 'up-to-date', manual, progress: 0, error: '' })
    }
    updateCandidate = candidate
    downloadedUpdate = null
    return setUpdateStatus({ phase: 'available', manual, progress: 0, total: candidate.asset.size, transferred: 0, speed: 0, error: '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!manual) {
      updateStatus = { phase: 'idle', currentVersion: app.getVersion(), progress: 0, error: '' }
      return publicUpdateStatus()
    }
    return setUpdateStatus({ phase: 'error', manual, error: message })
  }
}

function assertUpdateStage(versionRoot) {
  const resolvedBase = path.resolve(updatesBaseRoot)
  const resolvedStage = path.resolve(versionRoot)
  if (!resolvedStage.toLowerCase().startsWith(`${resolvedBase.toLowerCase()}${path.sep}`)) throw new Error('更新临时目录越界')
}

async function cleanupStaleUpdateStages() {
  if (postUpdateToken) return
  await updateFsp.mkdir(updatesBaseRoot, { recursive: true })
  const entries = await updateFsp.readdir(updatesBaseRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const stage = path.join(updatesBaseRoot, entry.name)
    assertUpdateStage(stage)
    await removeUpdateTree(stage)
  }
  await updateFsp.rm(updateCleanupFile, { force: true }).catch(() => {})
  await updateFsp.rm(updateProgressFile, { force: true }).catch(() => {})
}

async function loadPreviousUpdateFailure() {
  const message = await updateFsp.readFile(updateFailureFile, 'utf8').catch(() => '')
  if (!message.trim()) return
  updateStatus = {
    phase: 'error', currentVersion: app.getVersion(), progress: 0, manual: true,
    error: `上次更新未能完成，当前版本已保留。\n${message.trim()}`,
  }
}

async function waitForUpdateHandoff(handoffPath, updater, timeoutMs = 6_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (updateFs.existsSync(handoffPath)) return true
    if (updater.exitCode !== null) throw new Error(`更新器提前退出（${updater.exitCode}）`)
    await delay(100)
  }
  throw new Error('更新器接管超时，当前软件保持运行，请重试')
}

async function downloadUpdate() {
  if (!updateCandidate) throw new Error('没有可下载的更新')
  if (downloadedUpdate) return setUpdateStatus({ phase: 'downloaded', progress: 100 })
  if (updateWork) return updateWork
  updateWork = (async () => {
    await staleUpdateCleanup
    const version = safeVersion(updateCandidate.version)
    const versionRoot = path.join(updatesBaseRoot, version)
    const archivePath = path.join(versionRoot, updateCandidate.asset.name)
    const payloadRoot = path.join(versionRoot, 'payload')
    assertUpdateStage(versionRoot)
    await removeUpdateTree(versionRoot)
    await updateFsp.mkdir(versionRoot, { recursive: true })
    const disk = fs.statfsSync(dataRoot)
    const freeBytes = Number(disk.bavail) * Number(disk.bsize)
    const requiredBytes = Math.max(512 * 1024 ** 2, updateCandidate.asset.size * 3)
    if (freeBytes < requiredBytes) throw new Error(`磁盘可用空间不足，至少需要 ${Math.ceil(requiredBytes / 1024 ** 2)} MB`)
    const response = await net.fetch(updateCandidate.asset.url, {
      headers: { 'User-Agent': `StarBrowser/${app.getVersion()}` },
      redirect: 'follow',
    })
    if (!response.ok || !response.body) throw new Error(`更新包下载失败（${response.status}）`)
    const file = await updateFsp.open(archivePath, 'w')
    const hash = createHash('sha256')
    const reader = response.body.getReader()
    const startedAt = Date.now()
    let lastPublishedAt = 0
    let transferred = 0
    setUpdateStatus({ phase: 'downloading', progress: 0, transferred: 0, total: updateCandidate.asset.size, speed: 0, error: '' })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        await file.write(chunk)
        hash.update(chunk)
        transferred += chunk.length
        const now = Date.now()
        if (now - lastPublishedAt >= 120) {
          lastPublishedAt = now
          setUpdateStatus({
            phase: 'downloading', transferred,
            total: updateCandidate.asset.size || transferred,
            progress: updateCandidate.asset.size ? Math.min(99, Math.round(transferred / updateCandidate.asset.size * 1000) / 10) : 0,
            speed: Math.round(transferred / Math.max(1, (now - startedAt) / 1000)),
          })
        }
      }
    } finally {
      await file.close()
    }
    if (hash.digest('hex').toLowerCase() !== updateCandidate.asset.sha256) throw new Error('更新包校验失败，文件可能不完整')
    setUpdateStatus({ phase: 'extracting', progress: 99, transferred, total: transferred, speed: 0 })
    await updateFsp.mkdir(payloadRoot, { recursive: true })
    await secureExtractZip(archivePath, payloadRoot)
    const programManifest = parseProgramManifest(JSON.parse(await updateFsp.readFile(path.join(payloadRoot, 'starbrowser-update.json'), 'utf8')))
    if (safeVersion(programManifest.version) !== version) throw new Error('更新包版本与发布版本不一致')
    for (const name of programManifest.ownedTopLevel) {
      if (!updateFs.existsSync(path.join(payloadRoot, name))) throw new Error(`更新包缺少程序文件：${name}`)
    }
    downloadedUpdate = { versionRoot, payloadRoot, archivePath, programManifest }
    return setUpdateStatus({ phase: 'downloaded', progress: 100, transferred, total: transferred, speed: 0, error: '' })
  })().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (updateCandidate) {
      const failedRoot = path.join(updatesBaseRoot, safeVersion(updateCandidate.version))
      assertUpdateStage(failedRoot)
      await removeUpdateTree(failedRoot).catch(() => {})
    }
    return setUpdateStatus({ phase: 'error', error: message, speed: 0 })
  }).finally(() => { updateWork = null })
  return updateWork
}

async function readInstalledProgramManifest() {
  try {
    return parseProgramManifest(JSON.parse(await fsp.readFile(path.join(portableRoot, 'starbrowser-update.json'), 'utf8')), true)
  } catch {
    return legacyProgramManifest()
  }
}

async function snapshotUpdateSafety(targetVersionRoot) {
  const safetyRoot = path.join(targetVersionRoot, 'safety')
  await fsp.mkdir(safetyRoot, { recursive: true })
  for (const source of [stateFile, stateBackupFile, compatibilityFile]) {
    try { await fsp.copyFile(source, path.join(safetyRoot, path.basename(source))) } catch { /* A first-run file may not exist yet. */ }
  }
  await fsp.writeFile(path.join(safetyRoot, 'migration-plan.json'), `${JSON.stringify({
    fromVersion: app.getVersion(),
    toVersion: updateCandidate?.version,
    createdAt: new Date().toISOString(),
    current: APP_COMPATIBILITY,
    target: updateCandidate?.compatibility || APP_COMPATIBILITY,
  }, null, 2)}\n`, 'utf8')
}

async function installDownloadedUpdate() {
  if (!downloadedUpdate || !updateCandidate) throw new Error('更新尚未下载完成')
  setUpdateStatus({ phase: 'installing', progress: 100, error: '' })
  stateDirty = true
  await saveStateNow()
  const sessionsToFlush = [...configuredPartitions].map((partition) => session.fromPartition(partition).flushStorageData())
  sessionsToFlush.push(mainWindow?.webContents?.session?.flushStorageData?.() || Promise.resolve())
  await Promise.allSettled(sessionsToFlush)
  await snapshotUpdateSafety(downloadedUpdate.versionRoot)
  const oldProgramManifest = await readInstalledProgramManifest()
  const token = randomBytes(16).toString('hex')
  const handoffPath = path.join(downloadedUpdate.versionRoot, `handoff-${token}.ready`)
  const script = buildApplyUpdatePowerShell({
    targetRoot: portableRoot,
    payloadRoot: downloadedUpdate.payloadRoot,
    updatesRoot: downloadedUpdate.versionRoot,
    mainPid: process.pid,
    token,
    oldOwnedTopLevel: oldProgramManifest.ownedTopLevel,
    newOwnedTopLevel: downloadedUpdate.programManifest.ownedTopLevel,
  })
  const workerScriptPath = path.join(downloadedUpdate.versionRoot, 'apply-update-worker.ps1')
  const uiScriptPath = path.join(downloadedUpdate.versionRoot, 'apply-update.ps1')
  const uiScript = buildUpdateUiPowerShell({
    workerScript: workerScriptPath,
    progressFile: updateProgressFile,
    failureFile: updateFailureFile,
    version: downloadedUpdate.programManifest.version,
  })
  await updateFsp.rm(handoffPath, { force: true }).catch(() => {})
  await updateFsp.rm(updateProgressFile, { force: true }).catch(() => {})
  await updateFsp.writeFile(workerScriptPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]))
  await updateFsp.writeFile(uiScriptPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(uiScript, 'utf16le')]))
  const launchScriptPath = updateIntegrationMode ? workerScriptPath : uiScriptPath
  const updater = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    ...(updateIntegrationMode ? [] : ['-STA']),
    '-WindowStyle', 'Hidden', '-File', launchScriptPath,
  ], { detached: true, windowsHide: true, stdio: 'ignore', cwd: os.tmpdir() })
  await new Promise((resolve, reject) => {
    updater.once('spawn', resolve)
    updater.once('error', reject)
  })
  try {
    await waitForUpdateHandoff(handoffPath, updater)
  } catch (error) {
    try { updater.kill() } catch { /* It may already have exited. */ }
    return setUpdateStatus({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
  }
  updater.unref()
  quitting = true
  quitPrepared = true
  mainWindow?.hide()
  setTimeout(() => app.quit(), 120)
  setTimeout(() => app.exit(0), 5_000).unref()
  return { ok: true }
}

function ignoreUpdateVersion(version) {
  if (!state) return false
  const normalized = safeVersion(version)
  state.settings.ignoredUpdateVersion = normalized
  stateDirty = true
  updateCandidate = null
  downloadedUpdate = null
  setUpdateStatus({ phase: 'idle', progress: 0, error: '' })
  return true
}

async function writeCompatibilityLedger() {
  const previous = await fsp.readFile(compatibilityFile, 'utf8').then(JSON.parse).catch(() => null)
  const history = Array.isArray(previous?.history) ? previous.history.slice(-19) : []
  if (!previous || previous.appVersion !== app.getVersion()) {
    history.push({ appVersion: app.getVersion(), startedAt: new Date().toISOString(), compatibility: APP_COMPATIBILITY })
  }
  const temporary = `${compatibilityFile}.${process.pid}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify({ appVersion: app.getVersion(), ...APP_COMPATIBILITY, history }, null, 2)}\n`, 'utf8')
  await fsp.rename(temporary, compatibilityFile)
}

async function markPostUpdateHealthy() {
  if (!/^[a-f0-9]{32}$/.test(postUpdateToken) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(postUpdateVersion)) return
  const versionRoot = path.join(updatesBaseRoot, postUpdateVersion)
  assertUpdateStage(versionRoot)
  await writeCompatibilityLedger()
  await updateFsp.writeFile(path.join(versionRoot, `health-${postUpdateToken}.ok`), new Date().toISOString(), 'utf8')
}

function partitionFor(sessionId) {
  return `persist:starbrowser_${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function configureSession(sessionId) {
  const partition = partitionFor(sessionId)
  const ses = session.fromPartition(partition, { cache: true })
  if (!configuredPartitions.has(partition)) {
    configuredPartitions.add(partition)
    ses.setSpellCheckerEnabled(false)
    ses.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
    })
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
    })
  }
  return ses
}

function queryNtp(server, timeout = 2600) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    const packet = Buffer.alloc(48)
    packet[0] = 0x1b
    const started = performance.now()
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('NTP timeout')), timeout)
    socket.once('error', (error) => finish(error))
    socket.once('message', (message) => {
      if (message.length < 48 || message[1] === 0) return finish(new Error('Invalid NTP response'))
      const seconds = message.readUInt32BE(40)
      const fraction = message.readUInt32BE(44)
      const unixMilliseconds = (seconds - 2_208_988_800 + fraction / 2 ** 32) * 1000
      const halfRoundTrip = Math.max(0, performance.now() - started) / 2
      finish(null, { now: Math.round(unixMilliseconds + halfRoundTrip), source: server })
    })
    socket.send(packet, 123, server, (error) => { if (error) finish(error) })
  })
}

async function syncChinaNetworkTime() {
  const servers = ['ntp.aliyun.com', 'ntp1.aliyun.com', 'ntp2.aliyun.com']
  for (const server of servers) {
    try {
      const result = await queryNtp(server)
      if (Number.isFinite(result.now)) return { ok: true, ...result }
    } catch {
      // Try the next built-in China time source.
    }
  }
  return { ok: false, error: '暂时无法连接中国网络时间服务器' }
}

async function clearSessionData(sessionId) {
  const ses = configureSession(sessionId)
  await Promise.allSettled([ses.clearCache(), ses.clearStorageData()])
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#f7f7fb',
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: smokeMode ? false : true,
      spellcheck: false,
    },
  })
  mainWindow.webContents.session.setSpellCheckerEnabled(false)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!/^https?:\/\//i.test(params.src || '')) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.backgroundThrottling = smokeMode ? false : true
    webPreferences.spellcheck = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    const sessionId = partition.replace(/^persist:starbrowser_/, '')
    if (sessionId) configureSession(sessionId)
  })
  mainWindow.webContents.on('did-attach-webview', (_event, contents) => {
    const guestId = contents.id
    configuredGuestIds.add(guestId)
    contents.once('destroyed', () => configuredGuestIds.delete(guestId))
    if (!smokeMode) contents.setBackgroundThrottling(true)
    contents.session.setSpellCheckerEnabled(false)
    const policy = PERFORMANCE_POLICIES[effectivePerformanceTier()] || PERFORMANCE_POLICIES.medium
    contents.setFrameRate(policy.backgroundFrameRate)
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) send('browser:new-window', { url })
      else void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('context-menu', (_contextEvent, params) => showWebContextMenu(contents, params))
    contents.on('before-input-event', (event, input) => {
      if (!input.control || input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      if (key === 'l') { event.preventDefault(); send('browser:command', 'focus-address') }
      if (key === 't') { event.preventDefault(); send('browser:command', 'new-tab') }
      if (key === 'w') { event.preventDefault(); send('browser:command', 'close-tab') }
    })
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error('Preload error', preloadPath, error))
  mainWindow.webContents.on('context-menu', (_event, params) => showRendererContextMenu(mainWindow.webContents, params))
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`[renderer] ${details.message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error('Renderer process gone', details))
  mainWindow.webContents.once('did-finish-load', () => {
    if (postUpdateToken) void markPostUpdateHealthy()
      .catch((error) => console.error('Post-update health check failed', error))
      .finally(() => {
        if (updateIntegrationMode) {
          quitting = true
          quitPrepared = true
          app.exit(0)
        }
      })
    if (!smokeMode && !captureMode && !postUpdateToken && updateStatus.phase !== 'error') setTimeout(() => void checkForUpdates({ manual: false }), 3_500).unref()
  })
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else void mainWindow.loadFile(path.join(projectRoot, 'dist-renderer', 'index.html'), smokeMode || captureMode ? { query: { smoke: '1' } } : undefined)

  mainWindow.once('ready-to-show', () => {
    if (!smokeMode && !captureMode) mainWindow.show()
  })
  if (smokeMode) mainWindow.webContents.once('did-finish-load', () => void runSmokeCheck())
  if (captureMode && !updateIntegrationMode) mainWindow.webContents.once('did-finish-load', () => void runReadmeCapture())
  mainWindow.on('resize', () => send('window:changed', { maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() }))
  mainWindow.on('maximize', () => send('window:changed', { maximized: true, fullscreen: false }))
  mainWindow.on('unmaximize', () => send('window:changed', { maximized: false, fullscreen: false }))
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    const behavior = state?.settings?.closeBehavior || 'ask'
    if (behavior === 'tray') hideToTray()
    else if (behavior === 'exit') void exitApplication()
    else send('app:close-request')
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function runReadmeCapture() {
  try {
    if (!captureDir) throw new Error('缺少 STARBROWSER_CAPTURE_DIR')
    await fsp.mkdir(captureDir, { recursive: true })
    await delay(1_500)
    await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.prepareShowcase()`)
    await delay(7_000)
    const capture = async (name) => {
      await mainWindow.webContents.capturePage()
      await delay(220)
      const image = await mainWindow.webContents.capturePage()
      await fsp.writeFile(path.join(captureDir, name), image.toPNG())
    }
    await capture('01-isolated-sessions.png')
    await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showShowcaseSession(1, 0)`)
    await delay(7_000)
    await capture('02-session-switch.png')
    await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showShowcaseSession(0, 0)`)
    await delay(1_000)
    const favoritesShowcase = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showFavoritesShowcase()`)
    if (!favoritesShowcase) throw new Error('收藏夹浮窗未完整显示')
    await delay(500)
    await capture('03-favorites.png')
    const memoShowcase = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showMemoShowcase()`)
    if (!memoShowcase) throw new Error('备注标签页未完整显示')
    await delay(500)
    await capture('04-memo.png')
    const sessionShowcase = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showSessionEditorShowcase()`)
    if (!sessionShowcase) throw new Error('会话设置浮窗未完整显示')
    await delay(500)
    await capture('05-session-settings.png')
    const settingsShowcase = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showSettingsShowcase()`)
    if (!settingsShowcase) throw new Error('设置浮窗未完整显示')
    await delay(500)
    await capture('06-performance.png')
    const pluginsShowcase = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.showPluginsShowcase()`)
    if (!pluginsShowcase) throw new Error('插件中心浮窗未完整显示')
    await delay(500)
    await capture('07-plugins.png')
    await fsp.writeFile(path.join(captureDir, 'capture-result.json'), JSON.stringify({ ok: true, isolatedDataRoot: dataRoot }, null, 2), 'utf8')
  } catch (error) {
    if (captureDir) await fsp.writeFile(path.join(captureDir, 'capture-result.json'), JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }, null, 2), 'utf8').catch(() => {})
  }
  quitting = true
  quitPrepared = true
  app.exit(0)
}

async function runTransferSmokeCheck() {
  const smokeRoot = path.join(dataRoot, 'transfer-smoke')
  const sourceStorage = path.join(smokeRoot, 'source')
  const restoredStorage = path.join(smokeRoot, 'restored')
  const archivePath = path.join(smokeRoot, 'sample.sbsession')
  await fsp.mkdir(path.join(sourceStorage, 'Local Storage'), { recursive: true })
  await fsp.mkdir(path.join(sourceStorage, 'Cache'), { recursive: true })
  await fsp.writeFile(path.join(sourceStorage, 'Local Storage', 'credential.ldb'), 'credential-token', 'utf8')
  await fsp.writeFile(path.join(sourceStorage, 'Cache', 'must-not-export.cache'), 'cache-data', 'utf8')
  const exported = await runTransferWorker({
    operation: 'export',
    archivePath,
    storagePath: sourceStorage,
    password: 'starbrowser-smoke-password',
    session: { name: '加密会话测试', tabs: [{ id: 'tab-1', title: '测试', url: 'https://example.com/' }], activeTabId: 'tab-1' },
    cookies: [{ name: 'token', value: 'secret', domain: 'example.com', path: '/', secure: true }],
  })
  const imported = await runTransferWorker({ operation: 'import', archivePath, storagePath: restoredStorage, password: 'starbrowser-smoke-password' })
  let wrongPasswordRejected = false
  try {
    await runTransferWorker({ operation: 'import', archivePath, storagePath: path.join(smokeRoot, 'wrong-password'), password: 'wrong-password' })
  } catch (error) {
    wrongPasswordRejected = error?.code === 'WRONG_PASSWORD_OR_CORRUPT'
  }
  const credentialRestored = await fsp.readFile(path.join(restoredStorage, 'Local Storage', 'credential.ldb'), 'utf8').catch(() => '')
  const cacheExcluded = !fs.existsSync(path.join(restoredStorage, 'Cache', 'must-not-export.cache'))
  return {
    formatVersion: exported.formatVersion,
    algorithmVersion: exported.algorithmVersion,
    sessionName: imported.payload.session.name,
    cookieCount: imported.payload.cookies.length,
    credentialRestored: credentialRestored === 'credential-token',
    cacheExcluded,
    wrongPasswordRejected,
  }
}

async function runSmokeCheck() {
  const reportFile = path.join(dataRoot, 'smoke-result.json')
  const report = {
    ok: false,
    packaged: app.isPackaged,
    windowWasVisible: mainWindow?.isVisible() ?? true,
    renderer: null,
    browser: null,
    error: '',
  }
  try {
    await delay(2_000)
    const transferArchive = await runTransferSmokeCheck()
    const initial = await mainWindow.webContents.executeJavaScript(`(() => {
      const host = document.querySelector('.browser-host')?.getBoundingClientRect()
      const footer = document.querySelector('.sidebar-footer')?.getBoundingClientRect()
      const sidebar = document.querySelector('.sidebar')
      const list = document.querySelector('.session-list')
      const rail = document.querySelector('.session-list > .ps__rail-y')
      const sessionCard = document.querySelector('.session-card')
      const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null
      const listStyle = list ? getComputedStyle(list) : null
      const railStyle = rail ? getComputedStyle(rail) : null
      const sessionCardStyle = sessionCard ? getComputedStyle(sessionCard) : null
      return {
        appReady: Boolean(document.querySelector('.app-shell')),
        sessionCount: document.querySelectorAll('.session-card').length,
        tabCount: document.querySelectorAll('.browser-tab:not(.memo-tab)').length,
        host: host ? { x: host.x, y: host.y, width: host.width, height: host.height } : null,
        sidebarFooter: footer ? { height: footer.height, toolCount: document.querySelectorAll('.sidebar-footer .footer-tool').length } : null,
        sessionCard: sessionCardStyle ? {
          borderWidth: parseFloat(sessionCardStyle.borderTopWidth),
          outlineWidth: parseFloat(sessionCardStyle.outlineWidth)
        } : null,
        scrollbar: sidebarStyle && listStyle && railStyle ? {
          rightGap: parseFloat(sidebarStyle.paddingRight) + parseFloat(listStyle.marginRight) + parseFloat(railStyle.right),
          railWidth: parseFloat(railStyle.width)
        } : null
      }
    })()`)
    const buttonFocus = await mainWindow.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector('[data-testid="settings-button"]')
      button?.focus()
      const focusedBeforePointerRelease = document.activeElement === button
      button?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      const pointerFocusReleased = document.activeElement !== button
      button?.focus()
      await new Promise((resolve) => setTimeout(resolve, 10))
      const keyboardFocusPreserved = document.activeElement === button
      button?.blur()
      return { focusedBeforePointerRelease, pointerFocusReleased, keyboardFocusPreserved }
    })()`)

    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="new-tab"]')?.click()`)
    await delay(800)
    const tabCountAfterCreate = await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('.browser-tab:not(.memo-tab):not(.tab-drag-preview)').length`)
    const sessionSwitch = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.sessionSwitchTabOverlap()`)
    const expiryBadge = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.expiryBadgeCheck()`)
    const mixedWidthTabCrossing = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.mixedWidthTabCrossingCheck()`)
    const neverRecyclePreserved = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.neverRecycleCheck()`)
    const reorder = await mainWindow.webContents.executeJavaScript(`(async () => {
      const before = window.__starbrowserTest?.getTabOrder() || []
      const changed = window.__starbrowserTest?.reorderTabs(0, 1) || false
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const after = window.__starbrowserTest?.getTabOrder() || []
      const dom = [...document.querySelectorAll('.browser-tab[data-tab-id]:not(.memo-tab)')].map((element) => element.dataset.tabId)
      const targets = [
        window.__starbrowserTest?.targetTabIndex(-500, 100, 120, 4),
        window.__starbrowserTest?.targetTabIndex(355, 100, 120, 4),
        window.__starbrowserTest?.targetTabIndex(9999, 100, 120, 4)
      ]
      return { before, after, dom, changed, targets }
    })()`)
    const sessionMenuOverlay = await mainWindow.webContents.executeJavaScript(`(async () => {
      const trigger = document.querySelector('.session-card.active .session-actions button[aria-label="更多操作"]')
      trigger?.click()
      await new Promise((resolve) => setTimeout(resolve, 350))
      const menus = [...document.querySelectorAll('.n-dropdown-menu')]
      const menu = menus.findLast((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      const rect = menu?.getBoundingClientRect()
      const result = {
        visible: Boolean(rect && rect.width > 80 && rect.height > 40),
        insideViewport: Boolean(rect && rect.left >= 4 && rect.top >= 4 && rect.right <= innerWidth - 4 && rect.bottom <= innerHeight - 4),
        teleported: Boolean(menu && menu.parentElement?.closest('.modal-card, .sidebar') === null),
        dismissLayer: Boolean(document.querySelector('.session-menu-dismiss-layer')),
        menuAboveDismissLayer: Boolean(rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.n-dropdown-menu')),
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null
      }
      document.querySelector('.session-menu-dismiss-layer')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))
      result.dismissLayerRemoved = !document.querySelector('.session-menu-dismiss-layer')
      await new Promise((resolve) => setTimeout(resolve, 420))
      result.menuHidden = ![...document.querySelectorAll('.n-dropdown-menu')].some((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0
      })
      result.dismissed = result.dismissLayerRemoved && result.menuHidden
      return result
    })()`)

    const guestBefore = await mainWindow.webContents.executeJavaScript(`(async () => {
      let id = 0
      let view = null
      for (let attempt = 0; attempt < 50 && !id; attempt++) {
        view = document.querySelector('webview.browser-webview.active')
        try { id = view?.getWebContentsId?.() || 0 } catch { id = 0 }
        if (!id) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return {
        id,
        count: document.querySelectorAll('webview.browser-webview').length,
        visible: view ? getComputedStyle(view).visibility === 'visible' : false
      }
    })()`)
    const activeGuest = webContents.fromId(guestBefore.id)
    if (activeGuest && !activeGuest.isDestroyed()) {
      await activeGuest.executeJavaScript(`window.__starbrowserModalTicker = 0; window.__starbrowserModalTimer = setInterval(() => window.__starbrowserModalTicker++, 100)`)
    }

    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="settings-button"]')?.click()`)
    await delay(1_500)
    const modal = await mainWindow.webContents.executeJavaScript(`(() => ({
      settingsVisible: Boolean(document.querySelector('[data-testid="settings-modal"]')),
      performanceSelect: Boolean(document.querySelector('[data-testid="performance-select"]')),
      updateSettings: Boolean(document.querySelector('.settings-update-card')) && [...document.querySelectorAll('.settings-update-card button')].some((button) => button.textContent?.includes('检查更新')),
      snapshotPresent: Boolean(document.querySelector('.browser-snapshot')),
      webviewCount: document.querySelectorAll('webview.browser-webview').length,
      activeGuestId: (() => { try { return document.querySelector('webview.browser-webview.active')?.getWebContentsId?.() || 0 } catch { return 0 } })(),
      activeWebviewVisible: (() => {
        const view = document.querySelector('webview.browser-webview.active')
        if (!view) return false
        const style = getComputedStyle(view)
        return style.display !== 'none' && style.visibility === 'visible' && style.pointerEvents !== 'none'
      })(),
      title: document.querySelector('[data-testid="settings-modal"] .n-card-header__main')?.textContent?.trim() || ''
    }))()`)
    const settingsSelectOverlay = await mainWindow.webContents.executeJavaScript(`(async () => {
      const modalCard = document.querySelector('[data-testid="settings-modal"]')
      const modalRect = modalCard?.getBoundingClientRect()
      const content = modalCard?.querySelector(':scope > .n-card-content')
      const trigger = document.querySelector('[data-testid="performance-select"] .n-base-selection')
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 350))
      const menus = [...document.querySelectorAll('.n-base-select-menu')]
      const menu = menus.findLast((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      const rect = menu?.getBoundingClientRect()
      const result = {
        modalInsideViewport: Boolean(modalRect && modalRect.left >= 8 && modalRect.top >= 8 && modalRect.right <= innerWidth - 8 && modalRect.bottom <= innerHeight - 8),
        modalContentScrollable: Boolean(content && ['auto', 'scroll'].includes(getComputedStyle(content).overflowY)),
        visible: Boolean(rect && rect.width > 200 && rect.height > 80),
        insideViewport: Boolean(rect && rect.left >= 4 && rect.top >= 4 && rect.right <= innerWidth - 4 && rect.bottom <= innerHeight - 4),
        teleported: Boolean(menu && menu.parentElement?.closest('.modal-card') === null),
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return result
    })()`)
    const tickerDuringModal = activeGuest && !activeGuest.isDestroyed()
      ? await activeGuest.executeJavaScript(`window.__starbrowserModalTicker || 0`)
      : 0
    const sessionForm = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-testid="settings-modal"] .n-card-header__extra button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 700))
      document.querySelector('[data-testid="new-session"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 700))
      const recycleSelect = document.querySelector('[data-testid="session-modal"] .n-select .n-base-selection')
      const selectRect = recycleSelect?.getBoundingClientRect()
      recycleSelect?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 350))
      const selectMenus = [...document.querySelectorAll('.n-base-select-menu')]
      const selectMenu = selectMenus.at(-1)
      const selectMenuRect = selectMenu?.getBoundingClientRect()
      const selectMenuText = selectMenus.map((menu) => menu.textContent || '').join(' ')
      return {
        sessionModalVisible: Boolean(document.querySelector('[data-testid="session-modal"]')),
        availableFieldRemoved: !document.querySelector('[data-testid="available-picker"]') && !document.querySelector('[data-testid="session-modal"]')?.textContent?.includes('可用时间'),
        recycleSelect: {
          visible: Boolean(selectMenuRect && selectMenuRect.width > 200 && selectMenuRect.height > 150),
          optionCount: ['永不回收', '1 天', '7 天', '15 天', '30 天', '自定义'].filter((label) => selectMenuText.includes(label)).length,
          insideViewport: Boolean(selectMenuRect && selectMenuRect.top >= 0 && selectMenuRect.bottom <= innerHeight),
          opensUp: Boolean(selectMenuRect && selectRect && selectMenuRect.bottom <= selectRect.top + 2)
        }
      }
    })()`)
    const inputLayer = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-testid="session-modal"] .n-card-header__extra button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 900))
      const inspect = () => {
        const host = document.querySelector('.browser-host')
        const rect = host?.getBoundingClientRect()
        const views = [...document.querySelectorAll('webview.browser-webview')]
        const styles = views.map((view) => {
          const style = getComputedStyle(view)
          return {
            id: (() => { try { return view.getWebContentsId?.() || 0 } catch { return 0 } })(),
            active: view.classList.contains('active'),
            display: style.display,
            pointerEvents: style.pointerEvents,
            width: view.getBoundingClientRect().width,
            height: view.getBoundingClientRect().height
          }
        })
        const hits = []
        if (rect) {
          for (const xRatio of [0.08, 0.25, 0.5, 0.75, 0.92]) {
            for (const yRatio of [0.08, 0.25, 0.5, 0.75, 0.92]) {
              const element = document.elementFromPoint(rect.left + rect.width * xRatio, rect.top + rect.height * yRatio)
              hits.push({
                tag: element?.tagName || '',
                className: typeof element?.className === 'string' ? element.className : '',
                id: element?.id || '',
                pointerEvents: element ? getComputedStyle(element).pointerEvents : '',
                active: element?.classList.contains('active') || false
              })
            }
          }
        }
        return {
          styles,
          hits,
          allHitsActiveWebview: hits.length === 25 && hits.every((hit) => hit.tag === 'WEBVIEW' && hit.active),
          onlyOneInputView: styles.filter((style) => style.display !== 'none' && style.pointerEvents !== 'none').length === 1,
          backgroundViewsOutOfLayout: styles.filter((style) => !style.active).every((style) => style.display === 'none' && style.width === 0 && style.height === 0),
          activeGuestId: (() => { try { return views.find((view) => view.classList.contains('active'))?.getWebContentsId?.() || 0 } catch { return 0 } })()
        }
      }
      const before = inspect()
      const activeIndex = window.__starbrowserTest?.getTabOrder().findIndex((id) => id === document.querySelector('.browser-tab.active')?.dataset.tabId) ?? 0
      const targetIndex = activeIndex === 0 ? 1 : 0
      await window.__starbrowserTest?.activateTabAt(targetIndex)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const afterSwitch = inspect()
      return { before, afterSwitch, switchedGuest: before.activeGuestId > 0 && afterSwitch.activeGuestId > 0 && before.activeGuestId !== afterSwitch.activeGuestId }
    })()`)
    const memoAndChrome = await mainWindow.webContents.executeJavaScript(`(async () => {
      const roundTrip = await window.__starbrowserTest?.memoRoundTrip()
      const before = window.__starbrowserTest?.getHeaderOrder() || []
      const memoIndex = before.indexOf('__memo__')
      const changed = memoIndex > 0 ? window.__starbrowserTest?.reorderHeaderItems(memoIndex, 0) : true
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const after = window.__starbrowserTest?.getHeaderOrder() || []
      const dom = [...document.querySelectorAll('.browser-tab[data-tab-id]:not(.tab-drag-preview)')].map((element) => element.dataset.tabId)
      const firstBrowserIndex = after.findIndex((id) => id !== '__memo__')
      const browserChanged = firstBrowserIndex > 0 ? window.__starbrowserTest?.reorderHeaderItems(firstBrowserIndex, 0) : true
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const browserFirst = window.__starbrowserTest?.getHeaderOrder() || []
      const browserFirstDom = [...document.querySelectorAll('.browser-tab[data-tab-id]:not(.tab-drag-preview)')].map((element) => element.dataset.tabId)
      const dragSpace = document.querySelector('.window-drag-space')
      const titlebar = document.querySelector('.titlebar')
      return {
        roundTrip,
        changed,
        before,
        after,
        dom,
        memoMoved: after[0] === '__memo__' && JSON.stringify(after) === JSON.stringify(dom),
        browserChanged,
        browserCanLeadMemo: browserFirst[0] !== '__memo__' && browserFirst[1] === '__memo__' && JSON.stringify(browserFirst) === JSON.stringify(browserFirstDom),
        nativeDragRegion: getComputedStyle(dragSpace).webkitAppRegion === 'drag' && getComputedStyle(titlebar).webkitAppRegion === 'drag'
      }
    })()`)
    const favoritesUi = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.favorites-home')?.click()
      await new Promise((resolve) => setTimeout(resolve, 350))
      const manager = document.querySelector('.favorite-manager')
      const rect = manager?.getBoundingClientRect()
      const result = {
        visible: Boolean(manager),
        contentPane: Boolean(document.querySelector('.favorite-content')),
        singlePane: Boolean(rect && rect.width > 600 && rect.height > 350 && !document.querySelector('.favorite-folders')),
        noFolderControls: !document.querySelector('.favorite-folder-create, .folder-field, .folder-row'),
        flatData: Boolean(window.__starbrowserTest?.favoritesFlatCheck())
      }
      document.querySelector('[data-testid="favorites-modal"] .n-card-header__extra button')?.click()
      return result
    })()`)
    const pluginUi = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-testid="plugins-button"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 700))
      const modal = document.querySelector('[data-testid="plugins-modal"]')
      const rect = modal?.getBoundingClientRect()
      const text = modal?.textContent || ''
      const centerIcon = modal?.querySelector('.plugin-card .plugin-icon')
      const mockSettingsHead = document.createElement('div')
      mockSettingsHead.className = 'plugin-settings-head'
      const settingsIcon = centerIcon?.cloneNode(true)
      if (settingsIcon) mockSettingsHead.append(settingsIcon)
      document.body.append(mockSettingsHead)
      const centerStyle = centerIcon ? getComputedStyle(centerIcon) : null
      const settingsStyle = settingsIcon ? getComputedStyle(settingsIcon) : null
      const badgeRules = window.__starbrowserTest?.pluginBadgeRulesCheck()
      const result = {
        visible: Boolean(rect && rect.width > 650 && rect.height > 400),
        tabs: text.includes('全部插件') && text.includes('已安装'),
        importReady: text.includes('导入 JSON'),
        declarativeSafety: text.includes('不能执行任意代码'),
        availableFieldRemoved: !text.includes('可用时间'),
        iconConsistent: Boolean(centerStyle && settingsStyle && centerStyle.width === settingsStyle.width && centerStyle.height === settingsStyle.height && centerStyle.color === settingsStyle.color && centerStyle.fontSize === settingsStyle.fontSize),
        badgeRules
      }
      mockSettingsHead.remove()
      document.querySelector('[data-testid="plugins-modal"] .n-card-header__extra button')?.click()
      return result
    })()`)
    const recycleOverlay = await mainWindow.webContents.executeJavaScript(`(async () => {
      const sessionId = await window.__starbrowserTest?.prepareRecycleOverlayCheck()
      document.querySelector('[data-testid="recycle-button"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 450))
      const row = [...document.querySelectorAll('.recycle-row')].find((element) => element.textContent?.includes('浮层边界测试'))
      const buttons = row ? [...row.querySelectorAll('button')] : []
      buttons.at(-1)?.click()
      await new Promise((resolve) => setTimeout(resolve, 350))
      const popovers = [...document.querySelectorAll('.n-popover-shared')]
      const popover = popovers.findLast((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && element.textContent?.includes('此操作无法撤销')
      })
      const rect = popover?.getBoundingClientRect()
      const result = {
        visible: Boolean(rect && rect.width > 180 && rect.height > 50),
        completeText: Boolean(popover?.textContent?.includes('取消') && popover?.textContent?.includes('确认删除')),
        insideViewport: Boolean(rect && rect.left >= 4 && rect.top >= 4 && rect.right <= innerWidth - 4 && rect.bottom <= innerHeight - 4),
        teleported: Boolean(popover && popover.parentElement?.closest('.modal-card') === null),
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null
      }
      const cancel = [...(popover?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('取消'))
      cancel?.click()
      document.querySelector('[data-testid="recycle-modal"] .n-card-header__extra button')?.click()
      await window.__starbrowserTest?.cleanupRecycleOverlayCheck(sessionId)
      return result
    })()`)
    const updateUi = await mainWindow.webContents.executeJavaScript(`(async () => {
      await window.starbrowser.update.simulateForSmoke()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const modal = document.querySelector('[data-testid="update-modal"]')
      const rect = modal?.getBoundingClientRect()
      const text = modal?.textContent || ''
      const result = {
        visible: Boolean(modal && rect && rect.width > 500 && rect.height > 300),
        insideViewport: Boolean(rect && rect.left >= 8 && rect.top >= 8 && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8),
        versionShown: text.includes('v' + ${JSON.stringify(app.getVersion())}) && text.includes('v9.9.9'),
        actionsShown: ['忽略此版本', '稍后', '下载更新'].every((label) => text.includes(label)),
        safetyShown: ['SHA-256 完整性校验', 'data 永不覆盖', '启动失败自动回滚', '兼容迁移清单'].every((label) => text.includes(label)),
        progressReady: Boolean(document.querySelector('[data-testid="update-modal"] .update-dialog'))
      }
      document.querySelector('[data-testid="update-modal"] .n-card-header__extra button')?.click()
      return result
    })()`)
    const activeAfterSwitch = webContents.fromId(inputLayer.afterSwitch.activeGuestId)
    const guestContextMenuReady = Boolean(activeAfterSwitch && !activeAfterSwitch.isDestroyed() && configuredGuestIds.has(activeAfterSwitch.id))
    const spellcheckDisabled = Boolean(activeAfterSwitch && !activeAfterSwitch.isDestroyed() && !activeAfterSwitch.session.isSpellCheckerEnabled() && !mainWindow.webContents.session.isSpellCheckerEnabled())
    const rendererContextMenuReady = mainWindow.webContents.listenerCount('context-menu') > 0
    const activationStability = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.activationStabilityCheck()`)
    const multiTabRestoreStability = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.multiTabRestoreStabilityCheck()`)
    const hoverPreload = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.hoverPreloadCheck()`)
    const performancePolicy = await mainWindow.webContents.executeJavaScript(`window.__starbrowserTest?.performancePolicyCheck()`)
    report.renderer = { ...initial, buttonFocus, tabCountAfterCreate, sessionSwitch, expiryBadge, mixedWidthTabCrossing, neverRecyclePreserved, reorder, sessionMenuOverlay, modal, settingsSelectOverlay, sessionForm, inputLayer, memoAndChrome, favoritesUi, pluginUi, recycleOverlay, updateUi, activationStability, multiTabRestoreStability, hoverPreload, performancePolicy }
    report.transferArchive = transferArchive
    report.browser = {
      engine: 'dom-webview',
      guestBefore,
      guestIdStable: guestBefore.id > 0 && guestBefore.id === modal.activeGuestId,
      tickerDuringModal,
      videoSurfaceRemainedLive: tickerDuringModal >= 5,
      guestContextMenuReady,
      rendererContextMenuReady,
      spellcheckDisabled,
    }
    report.windowWasVisible = mainWindow.isVisible()
    report.ok = Boolean(
      initial.appReady && initial.sessionCount > 0 && initial.host?.width > 500 && initial.host?.height > 300 &&
      initial.sidebarFooter?.height <= 44 && initial.sidebarFooter?.toolCount === 4 &&
      initial.sessionCard?.borderWidth === 0 && initial.sessionCard?.outlineWidth === 0 &&
      initial.scrollbar?.rightGap >= 3 && initial.scrollbar?.rightGap <= 8 && initial.scrollbar?.railWidth >= 5 &&
      buttonFocus.focusedBeforePointerRelease && buttonFocus.pointerFocusReleased && buttonFocus.keyboardFocusPreserved &&
      tabCountAfterCreate === initial.tabCount + 1 && sessionSwitch?.noOverlap && expiryBadge?.days === 3 && expiryBadge?.visible && /^\d+天前$/.test(expiryBadge?.relativeTime || '') && expiryBadge?.aligned && expiryBadge?.singleTagLine && mixedWidthTabCrossing?.browserCanLeadMemo && mixedWidthTabCrossing?.memoCanFollowBrowser && neverRecyclePreserved && reorder.changed &&
      reorder.before[0] === reorder.after[1] && JSON.stringify(reorder.after) === JSON.stringify(reorder.dom) &&
      JSON.stringify(reorder.targets) === JSON.stringify([0, 2, 3]) && sessionMenuOverlay.visible && sessionMenuOverlay.insideViewport && sessionMenuOverlay.teleported && sessionMenuOverlay.dismissLayer && sessionMenuOverlay.menuAboveDismissLayer && sessionMenuOverlay.dismissed &&
      modal.settingsVisible && modal.performanceSelect && modal.updateSettings && settingsSelectOverlay.modalInsideViewport && settingsSelectOverlay.modalContentScrollable &&
      settingsSelectOverlay.visible && settingsSelectOverlay.insideViewport && settingsSelectOverlay.teleported &&
      sessionForm.sessionModalVisible && sessionForm.availableFieldRemoved &&
      sessionForm.recycleSelect?.visible && sessionForm.recycleSelect?.insideViewport && sessionForm.recycleSelect?.opensUp &&
      !modal.snapshotPresent && modal.activeWebviewVisible && modal.webviewCount === guestBefore.count &&
      inputLayer.before.allHitsActiveWebview && inputLayer.before.onlyOneInputView && inputLayer.before.backgroundViewsOutOfLayout &&
      inputLayer.afterSwitch.allHitsActiveWebview && inputLayer.afterSwitch.onlyOneInputView && inputLayer.afterSwitch.backgroundViewsOutOfLayout && inputLayer.switchedGuest &&
      memoAndChrome.roundTrip?.retained && memoAndChrome.roundTrip?.layout?.aligned && memoAndChrome.memoMoved && memoAndChrome.browserChanged && memoAndChrome.browserCanLeadMemo && memoAndChrome.nativeDragRegion &&
      favoritesUi.visible && favoritesUi.contentPane && favoritesUi.singlePane && favoritesUi.noFolderControls && favoritesUi.flatData &&
      pluginUi.visible && pluginUi.tabs && pluginUi.importReady && pluginUi.declarativeSafety && pluginUi.availableFieldRemoved && pluginUi.iconConsistent && JSON.stringify(pluginUi.badgeRules?.types) === JSON.stringify(['success', 'info', 'warning', 'error']) && pluginUi.badgeRules?.freshCycleHidden && pluginUi.badgeRules?.usedCycleVisible &&
      recycleOverlay.visible && recycleOverlay.completeText && recycleOverlay.insideViewport && recycleOverlay.teleported &&
      updateUi.visible && updateUi.insideViewport && updateUi.versionShown && updateUi.actionsShown && updateUi.safetyShown && updateUi.progressReady &&
      activationStability.guestStable && activationStability.navigationStable &&
      multiTabRestoreStability.primaryGuestStable && multiTabRestoreStability.primaryNavigationStable && multiTabRestoreStability.secondaryGuestReady && multiTabRestoreStability.sameSessionRetained && multiTabRestoreStability.sameSessionNavigationStable && multiTabRestoreStability.preloadRemoved &&
      hoverPreload.liveStable && hoverPreload.domStable && hoverPreload.apiRemoved &&
      performancePolicy.lowLiveTabs >= 5 && performancePolicy.lowLiveSessions === 1 && performancePolicy.lowDomGuests >= 5 &&
      performancePolicy.mediumBudget === 6 && performancePolicy.highBudget === 9 && performancePolicy.ultraHighBudget === 12 &&
      performancePolicy.fixedUnderCritical && performancePolicy.criticalRuntimeBudget === 1 && performancePolicy.constrainedRuntimeBudget === 5 && performancePolicy.memoryCappedBudget <= 2 &&
      performancePolicy.recommendedTier === 'balanced' && performancePolicy.lowVisualMode && performancePolicy.restoredMode &&
      transferArchive.formatVersion === 1 && transferArchive.algorithmVersion === 1 && transferArchive.sessionName === '加密会话测试' &&
      transferArchive.cookieCount === 1 && transferArchive.credentialRestored && transferArchive.cacheExcluded && transferArchive.wrongPasswordRejected &&
      report.browser.guestIdStable && report.browser.videoSurfaceRemainedLive && report.browser.guestContextMenuReady && report.browser.rendererContextMenuReady && report.browser.spellcheckDisabled && !report.windowWasVisible
    )
  } catch (error) {
    report.error = error instanceof Error ? error.stack || error.message : String(error)
  }
  await fsp.mkdir(dataRoot, { recursive: true })
  await fsp.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8')
  quitting = true
  await saveStateNow()
  app.exit(report.ok ? 0 : 1)
}

function createTray() {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip('StarBrowser')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 StarBrowser', click: restoreFromTray },
    { type: 'separator' },
    { label: '退出', click: () => void exitApplication() },
  ]))
  tray.on('double-click', restoreFromTray)
}

function hideToTray() {
  createTray()
  mainWindow?.hide()
}

function restoreFromTray() {
  mainWindow?.show()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
}

async function exitApplication() {
  if (quitting) return
  quitting = true
  await saveStateNow()
  quitPrepared = true
  app.quit()
}

function registerIpc() {
  ipcMain.handle('state:get', () => state)
  ipcMain.on('state:update', (_event, nextState) => {
    const previousSessionIds = new Set((state?.sessions || []).map((item) => item.id))
    state = normalizeState(nextState)
    stateDirty = true
    const nextSessionIds = new Set(state.sessions.map((item) => item.id))
    const sessionSetChanged = previousSessionIds.size !== nextSessionIds.size || [...previousSessionIds].some((id) => !nextSessionIds.has(id))
    if (sessionSetChanged) pluginService?.sessionsChanged()
  })
  ipcMain.handle('browser:clear-session', (_event, sessionId) => clearSessionData(sessionId))
  ipcMain.handle('browser:export-session', (_event, payload) => exportSessionArchive(payload?.sessionId, payload?.password))
  ipcMain.handle('browser:import-session', (_event, payload) => importSessionArchive(payload?.password))
  ipcMain.on('browser:apply-performance', (event, payload) => {
    if (event.sender !== mainWindow?.webContents) return
    applyGuestPerformance(payload)
  })
  ipcMain.on('window:control', (_event, action) => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'maximize') {
      if (state?.settings?.maximizeBehavior === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen())
      else if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
    if (action === 'close') mainWindow.close()
  })
  ipcMain.on('app:close-choice', (_event, choice) => {
    if (choice?.remember) {
      state.settings.closeBehavior = choice.action
      stateDirty = true
    }
    if (choice?.action === 'tray') hideToTray()
    if (choice?.action === 'exit') void exitApplication()
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_event, text) => clipboard.writeText(String(text ?? '')))
  ipcMain.handle('shell:open', (_event, url) => shell.openExternal(url))
  ipcMain.handle('time:sync', () => smokeMode ? { ok: true, now: Date.UTC(2026, 7, 20, 5, 0), source: 'smoke' } : syncChinaNetworkTime())
  ipcMain.handle('system:performance-profile', () => detectPerformanceProfile())
  ipcMain.handle('system:memory-status', () => getMemoryStatus())
  ipcMain.handle('plugins:get-state', () => pluginService?.publicState() || { catalog: [], installed: [], results: {} })
  ipcMain.handle('plugins:refresh-catalog', () => pluginService.refreshCatalog(true))
  ipcMain.handle('plugins:install', (_event, pluginId) => pluginService.install(String(pluginId || '')))
  ipcMain.handle('plugins:import', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '导入 StarBrowser 声明式插件',
      properties: ['openFile'],
      filters: [{ name: 'StarBrowser 插件', extensions: ['json'] }],
    })
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true, state: pluginService.publicState() }
    return { canceled: false, state: await pluginService.importFile(selection.filePaths[0]) }
  })
  ipcMain.handle('plugins:uninstall', (_event, payload) => pluginService.uninstall(String(payload?.pluginId || ''), Boolean(payload?.deleteConfig)))
  ipcMain.handle('plugins:update-config', (_event, payload) => pluginService.updateConfig(String(payload?.pluginId || ''), payload?.config))
  ipcMain.handle('plugins:run', (_event, pluginId) => pluginService.run(String(pluginId || ''), { reason: 'manual' }))
  ipcMain.handle('update:get-status', () => publicUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates({ manual: true }))
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installDownloadedUpdate())
  ipcMain.handle('update:ignore', (_event, version) => ignoreUpdateVersion(version))
  ipcMain.handle('update:smoke-available', () => {
    if (!smokeMode && !captureMode) throw new Error('仅测试或展示捕获模式可用')
    updateCandidate = {
      version: '9.9.9', name: 'StarBrowser 9.9.9', notes: '新增自动更新中心\n优化便携数据兼容与更新回滚',
      publishedAt: new Date().toISOString(), releaseUrl: `https://github.com/${UPDATE_REPOSITORY}`,
      asset: { name: 'smoke.zip', url: 'https://example.invalid/smoke.zip', size: 128 * 1024 ** 2, sha256: 'a'.repeat(64) },
      compatibility: APP_COMPATIBILITY,
    }
    return setUpdateStatus({ phase: 'available', manual: false, progress: 0, total: updateCandidate.asset.size, transferred: 0, speed: 0, error: '' })
  })
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', restoreFromTray)
  app.whenReady().then(async () => {
    await loadPreviousUpdateFailure()
    staleUpdateCleanup = cleanupStaleUpdateStages().catch((error) => {
      if (updateStatus.phase !== 'error') setUpdateStatus({
        phase: 'error', manual: true,
        error: `上次更新临时文件仍被系统占用，当前程序和 data 未受影响。\n${error instanceof Error ? error.message : String(error)}`,
      })
    })
    try {
      state = await loadState()
    } catch (error) {
      dialog.showErrorBox('StarBrowser 已保护数据', `检测到无法安全迁移的配置，软件没有覆盖原数据。\n\n${error instanceof Error ? error.message : String(error)}`)
      quitting = true
      quitPrepared = true
      app.exit(1)
      return
    }
    pluginService = new PluginService({
      dataRoot,
      projectRoot,
      appVersion: app.getVersion(),
      fetch: (url, options) => net.fetch(url, options),
      getSessions: () => state?.sessions || [],
      getSession: (sessionId) => configureSession(sessionId),
      notify: (payload) => send('plugins:state', payload),
    })
    await pluginService.initialize().catch((error) => console.error('Failed to initialize plugin engine', error))
    await writeCompatibilityLedger().catch((error) => console.error('Failed to write compatibility ledger', error))
    if (legacyCookieImportFile) {
      const report = await importLegacyCookies()
      quitting = true
      quitPrepared = true
      app.exit(report.ok ? 0 : 1)
      return
    }
    registerIpc()
    createWindow()
    setInterval(() => void saveStateNow(), 60_000).unref()
  })
  app.on('activate', () => {
    if (!mainWindow) createWindow()
    else restoreFromTray()
  })
  app.on('before-quit', (event) => {
    if (quitPrepared) {
      quitting = true
      return
    }
    event.preventDefault()
    quitting = true
    pluginService?.dispose()
    void saveStateNow().finally(() => {
      quitPrepared = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
