import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const ENGINE_SCHEMA_VERSION = 1
const PLUGIN_SCHEMA_VERSION = 1
const MAX_PLUGIN_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/aafqaq/StarBrowser/main/plugins/catalog.json'
const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,63}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

class PluginEngineError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function safeString(value, maximum = 500) {
  return String(value ?? '').trim().slice(0, maximum)
}

function getPath(value, dottedPath) {
  if (!dottedPath) return value
  return String(dottedPath).split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)]
    return plainObject(current) || typeof current === 'object' ? current[key] : undefined
  }, value)
}

function firstDefined(root, sources = []) {
  for (const source of sources) {
    const value = getPath(root, source)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function interpolate(value, context) {
  return String(value ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key) => {
    const result = getPath(context, key)
    return result === undefined || result === null ? '' : String(result)
  })
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function compareVersions(left, right) {
  const parse = (value) => String(value || '0.0.0').split('-')[0].split('.').map((part) => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true })
}

function normalizeOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new PluginEngineError('invalid-host', '插件仅允许访问 HTTPS 地址')
  return url.origin
}

function validateSetting(setting) {
  if (!plainObject(setting) || !/^[a-z][a-zA-Z0-9]{1,39}$/.test(setting.key || '')) throw new PluginEngineError('invalid-manifest', '插件设置项格式无效')
  if (!['select', 'number', 'boolean'].includes(setting.type)) throw new PluginEngineError('invalid-manifest', `不支持的设置类型：${setting.type}`)
  if (setting.type === 'select' && (!Array.isArray(setting.options) || !setting.options.length)) throw new PluginEngineError('invalid-manifest', '下拉设置缺少选项')
  return {
    key: setting.key,
    label: safeString(setting.label, 80),
    description: safeString(setting.description, 240),
    type: setting.type,
    default: setting.default,
    minimum: Number.isFinite(Number(setting.minimum)) ? Number(setting.minimum) : undefined,
    maximum: Number.isFinite(Number(setting.maximum)) ? Number(setting.maximum) : undefined,
    step: Number.isFinite(Number(setting.step)) ? Number(setting.step) : undefined,
    options: setting.type === 'select' ? setting.options.slice(0, 20).map((option) => ({ label: safeString(option?.label, 60), value: option?.value })) : undefined,
    visibleWhen: plainObject(setting.visibleWhen) ? { key: safeString(setting.visibleWhen.key, 40), equals: setting.visibleWhen.equals } : undefined,
  }
}

function validatePluginManifest(input) {
  if (!plainObject(input) || Number(input.schemaVersion) !== PLUGIN_SCHEMA_VERSION) throw new PluginEngineError('invalid-manifest', '插件格式版本不受支持')
  if (!PLUGIN_ID.test(input.id || '') || !VERSION.test(input.version || '')) throw new PluginEngineError('invalid-manifest', '插件标识或版本格式无效')
  const hosts = [...new Set((input.permissions?.hosts || []).map(normalizeOrigin))]
  if (!hosts.length || hosts.length > 8) throw new PluginEngineError('invalid-manifest', '插件必须声明有限的网络域名')
  const steps = input.hooks?.refresh?.steps
  if (!Array.isArray(steps) || !steps.length || steps.length > 5) throw new PluginEngineError('invalid-manifest', '插件刷新步骤数量无效')
  const stepIds = new Set()
  const stepOrigins = new Map()
  for (const step of steps) {
    if (!plainObject(step) || !/^[a-z][a-zA-Z0-9]{1,31}$/.test(step.id || '') || stepIds.has(step.id)) throw new PluginEngineError('invalid-manifest', '插件请求步骤标识无效')
    stepIds.add(step.id)
    if (String(step.request?.method || 'GET').toUpperCase() !== 'GET') throw new PluginEngineError('invalid-manifest', '声明式插件目前仅允许只读 GET 请求')
    const requestOrigin = normalizeOrigin(interpolate(step.request?.url, { steps: {} }).replace(/\{\{[^{}]+\}\}/g, 'placeholder'))
    if (!hosts.includes(requestOrigin)) throw new PluginEngineError('invalid-manifest', `请求域名未获授权：${requestOrigin}`)
    const requestTemplates = JSON.stringify({ url: step.request?.url, headers: step.request?.headers || {} })
    for (const match of requestTemplates.matchAll(/\{\{\s*steps\.([a-z][a-zA-Z0-9]{1,31})\./g)) {
      const sourceOrigin = stepOrigins.get(match[1])
      if (!sourceOrigin) throw new PluginEngineError('invalid-manifest', '插件引用了尚未完成的请求步骤')
      if (sourceOrigin !== requestOrigin) throw new PluginEngineError('unsafe-data-flow', '插件不能把一个网站的响应数据发送到其他网站')
    }
    stepOrigins.set(step.id, requestOrigin)
  }
  const settingsSchema = (input.settingsSchema || []).map(validateSetting)
  const cookieUrls = input.hooks?.sessionMatch?.cookieUrls || []
  if (!Array.isArray(cookieUrls) || cookieUrls.length > 8) throw new PluginEngineError('invalid-manifest', 'Cookie 匹配规则无效')
  for (const cookieUrl of cookieUrls) {
    if (!hosts.includes(normalizeOrigin(cookieUrl))) throw new PluginEngineError('invalid-manifest', 'Cookie 匹配地址未获授权')
  }
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: input.id,
    version: input.version,
    name: safeString(input.name, 80),
    description: safeString(input.description, 400),
    publisher: safeString(input.publisher, 80),
    homepage: safeString(input.homepage, 300),
    icon: safeString(input.icon, 40) || 'extension',
    permissions: { hosts, capabilities: [...new Set((input.permissions?.capabilities || []).map((item) => safeString(item, 60)))] },
    settingsSchema,
    hooks: clone(input.hooks),
  }
}

function validateCatalog(input) {
  if (!plainObject(input) || Number(input.schemaVersion) !== 1 || !Array.isArray(input.plugins)) throw new PluginEngineError('invalid-catalog', '插件目录格式无效')
  return input.plugins.slice(0, 100).map((entry) => {
    if (!PLUGIN_ID.test(entry?.id || '') || !VERSION.test(entry?.version || '')) throw new PluginEngineError('invalid-catalog', '插件目录包含无效条目')
    const manifestUrl = new URL(entry.manifestUrl)
    if (manifestUrl.protocol !== 'https:' || manifestUrl.hostname !== 'raw.githubusercontent.com' || !manifestUrl.pathname.startsWith('/aafqaq/StarBrowser/')) {
      throw new PluginEngineError('invalid-catalog', '插件下载地址不在受信任仓库中')
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) throw new PluginEngineError('invalid-catalog', '插件完整性摘要无效')
    return {
      id: entry.id,
      version: entry.version,
      name: safeString(entry.name, 80),
      description: safeString(entry.description, 400),
      publisher: safeString(entry.publisher, 80),
      icon: safeString(entry.icon, 40) || 'extension',
      manifestUrl: manifestUrl.toString(),
      sha256: entry.sha256.toLowerCase(),
    }
  })
}

function defaultEngineState() {
  return { schemaVersion: ENGINE_SCHEMA_VERSION, installed: {}, configs: {}, results: {} }
}

function normalizeEngineState(input) {
  const next = plainObject(input) ? input : defaultEngineState()
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    installed: plainObject(next.installed) ? next.installed : {},
    configs: plainObject(next.configs) ? next.configs : {},
    results: plainObject(next.results) ? next.results : {},
  }
}

function settingDefaults(manifest) {
  return Object.fromEntries(manifest.settingsSchema.map((setting) => [setting.key, setting.default]))
}

function sanitizeConfig(manifest, candidate) {
  const result = { ...settingDefaults(manifest) }
  const source = plainObject(candidate) ? candidate : {}
  for (const setting of manifest.settingsSchema) {
    const value = source[setting.key]
    if (setting.type === 'boolean' && typeof value === 'boolean') result[setting.key] = value
    if (setting.type === 'select' && setting.options.some((option) => option.value === value)) result[setting.key] = value
    if (setting.type === 'number' && Number.isFinite(Number(value))) {
      result[setting.key] = Math.max(setting.minimum ?? -Number.MAX_SAFE_INTEGER, Math.min(setting.maximum ?? Number.MAX_SAFE_INTEGER, Number(value)))
    }
  }
  return result
}

function transformedOutput(definition, context, now) {
  const source = firstDefined(context, definition.sources || [])
  if (source === undefined) return undefined
  if (definition.transform === 'number') {
    const value = Number(source)
    return Number.isFinite(value) ? value : undefined
  }
  if (definition.transform === 'lowercase') return String(source).toLowerCase()
  if (definition.transform === 'remaining-percent') {
    const value = Number(source)
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round((100 - value) * 10) / 10)) : undefined
  }
  if (definition.transform === 'epoch-seconds-to-iso') {
    const value = Number(source)
    return Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined
  }
  if (definition.transform === 'epoch-milliseconds-to-iso') {
    const value = Number(source)
    return Number.isFinite(value) ? new Date(value).toISOString() : undefined
  }
  if (definition.transform === 'seconds-from-now-to-iso') {
    const value = Number(source)
    return Number.isFinite(value) ? new Date(now + value * 1000).toISOString() : undefined
  }
  return source
}

function classifyResult(manifest, fields) {
  for (const rule of manifest.hooks?.refresh?.classify || []) {
    const value = fields[rule?.field]
    if (Array.isArray(rule?.in) && rule.in.map((item) => String(item).toLowerCase()).includes(String(value ?? '').toLowerCase())) {
      return { status: safeString(rule.status, 40) || 'not-applicable', message: safeString(rule.message, 240) }
    }
  }
  return { status: 'ok', message: '' }
}

function publicError(error) {
  if (error instanceof PluginEngineError) return { code: error.code, message: error.message }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'unknown', message: safeString(message, 240) || '未知错误' }
}

export class PluginService {
  constructor({ dataRoot, projectRoot, appVersion, fetch, getSessions, getSession, notify }) {
    this.root = path.join(dataRoot, 'plugins')
    this.packagesRoot = path.join(this.root, 'packages')
    this.stateFile = path.join(this.root, 'engine.json')
    this.catalogCacheFile = path.join(this.root, 'catalog-cache.json')
    this.localCatalogFile = path.join(projectRoot, 'plugins', 'catalog.json')
    this.localPluginsRoot = path.join(projectRoot, 'plugins')
    this.appVersion = appVersion
    this.fetch = fetch
    this.getSessions = getSessions
    this.getSession = getSession
    this.notify = notify
    this.state = defaultEngineState()
    this.catalog = []
    this.manifests = new Map()
    this.timers = new Map()
    this.running = new Map()
    this.saveWork = Promise.resolve()
    this.sessionChangeTimer = null
  }

  async initialize() {
    await fsp.mkdir(this.packagesRoot, { recursive: true })
    try { this.state = normalizeEngineState(JSON.parse(await fsp.readFile(this.stateFile, 'utf8'))) } catch { this.state = defaultEngineState() }
    await this.loadInstalledManifests()
    await this.refreshCatalog(false).catch(() => {})
    for (const pluginId of Object.keys(this.state.installed)) this.schedule(pluginId, true)
    this.emit()
  }

  async loadInstalledManifests() {
    for (const pluginId of Object.keys(this.state.installed)) {
      try {
        const text = await fsp.readFile(path.join(this.packagesRoot, `${pluginId}.json`), 'utf8')
        this.manifests.set(pluginId, validatePluginManifest(JSON.parse(text)))
      } catch (error) {
        this.state.installed[pluginId].loadError = publicError(error).message
      }
    }
  }

  async save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`
    this.saveWork = this.saveWork.then(async () => {
      await fsp.mkdir(this.root, { recursive: true })
      const temporary = `${this.stateFile}.${process.pid}.tmp`
      await fsp.writeFile(temporary, snapshot, 'utf8')
      await fsp.rename(temporary, this.stateFile)
    })
    return this.saveWork
  }

  emit() {
    this.notify?.(this.publicState())
  }

  publicState() {
    const installed = Object.entries(this.state.installed).map(([id, metadata]) => {
      const manifest = this.manifests.get(id)
      const catalog = this.catalog.find((item) => item.id === id)
      return {
        id,
        version: manifest?.version || metadata.version || '',
        name: manifest?.name || catalog?.name || id,
        description: manifest?.description || catalog?.description || '',
        publisher: manifest?.publisher || catalog?.publisher || '',
        icon: manifest?.icon || catalog?.icon || 'extension',
        settingsSchema: manifest?.settingsSchema || [],
        sessionBadges: Array.isArray(manifest?.hooks?.sessionBadges) ? clone(manifest.hooks.sessionBadges) : [],
        config: manifest ? sanitizeConfig(manifest, this.state.configs[id]) : {},
        installedAt: metadata.installedAt || '',
        loadError: metadata.loadError || '',
        running: this.running.has(id),
        updateAvailable: Boolean(catalog && manifest && compareVersions(catalog.version, manifest.version) > 0),
        availableVersion: catalog?.version || '',
      }
    })
    return { catalog: clone(this.catalog), installed, results: clone(this.state.results) }
  }

  async fetchBuffer(url, options = {}) {
    const response = await this.fetch(url, options)
    if (!response.ok) throw new PluginEngineError('download-failed', `下载失败（${response.status}）`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_PLUGIN_BYTES) throw new PluginEngineError('download-too-large', '插件文件超过大小限制')
    return buffer
  }

  async refreshCatalog(force = true) {
    let catalog = null
    try {
      const buffer = await this.fetchBuffer(DEFAULT_CATALOG_URL, {
        headers: { Accept: 'application/json', 'User-Agent': `StarBrowser/${this.appVersion}` },
        cache: force ? 'no-store' : 'default', redirect: 'follow',
      })
      catalog = validateCatalog(JSON.parse(buffer.toString('utf8')))
      await fsp.writeFile(this.catalogCacheFile, `${JSON.stringify({ schemaVersion: 1, plugins: catalog }, null, 2)}\n`, 'utf8')
    } catch (remoteError) {
      for (const candidate of [this.catalogCacheFile, this.localCatalogFile]) {
        try {
          catalog = validateCatalog(JSON.parse(await fsp.readFile(candidate, 'utf8')))
          break
        } catch { /* Continue to the next safe fallback. */ }
      }
      if (!catalog) throw remoteError
    }
    this.catalog = catalog
    this.emit()
    return this.publicState()
  }

  async install(pluginId) {
    const entry = this.catalog.find((item) => item.id === pluginId)
    if (!entry) throw new PluginEngineError('plugin-not-found', '插件目录中找不到该插件')
    let buffer
    try {
      buffer = await this.fetchBuffer(entry.manifestUrl, {
        headers: { Accept: 'application/json', 'User-Agent': `StarBrowser/${this.appVersion}` }, redirect: 'follow', cache: 'no-store',
      })
    } catch (remoteError) {
      try { buffer = await fsp.readFile(path.join(this.localPluginsRoot, pluginId, 'plugin.json')) } catch { throw remoteError }
    }
    if (sha256(buffer) !== entry.sha256) throw new PluginEngineError('integrity-failed', '插件完整性校验失败')
    const manifest = validatePluginManifest(JSON.parse(buffer.toString('utf8')))
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw new PluginEngineError('catalog-mismatch', '插件清单与目录信息不一致')
    const installedVersion = this.manifests.get(manifest.id)?.version
    if (installedVersion && compareVersions(manifest.version, installedVersion) < 0) throw new PluginEngineError('downgrade-blocked', '在线插件不允许降级')
    await this.activateManifest(manifest, buffer, installedVersion ? 'update' : 'install')
    return this.publicState()
  }

  async activateManifest(manifest, buffer, reason) {
    const target = path.join(this.packagesRoot, `${manifest.id}.json`)
    const temporary = `${target}.${process.pid}.tmp`
    const backup = `${target}.${process.pid}.backup`
    const previousManifest = this.manifests.get(manifest.id)
    const previousInstalled = this.state.installed[manifest.id] ? clone(this.state.installed[manifest.id]) : null
    const previousConfig = this.state.configs[manifest.id] ? clone(this.state.configs[manifest.id]) : undefined
    await fsp.writeFile(temporary, buffer)
    try {
      if (fs.existsSync(target)) await fsp.rename(target, backup)
      await fsp.rename(temporary, target)
      this.manifests.set(manifest.id, manifest)
      this.state.installed[manifest.id] = {
        version: manifest.version,
        installedAt: previousInstalled?.installedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: reason === 'import' ? 'local' : 'repository',
        loadError: '',
      }
      this.state.configs[manifest.id] = sanitizeConfig(manifest, this.state.configs[manifest.id])
      this.state.results[manifest.id] ||= {}
      await this.save()
      await fsp.rm(backup, { force: true })
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      await fsp.rm(target, { force: true }).catch(() => {})
      if (fs.existsSync(backup)) await fsp.rename(backup, target).catch(() => {})
      if (previousManifest) this.manifests.set(manifest.id, previousManifest)
      else this.manifests.delete(manifest.id)
      if (previousInstalled) this.state.installed[manifest.id] = previousInstalled
      else delete this.state.installed[manifest.id]
      if (previousConfig !== undefined) this.state.configs[manifest.id] = previousConfig
      else delete this.state.configs[manifest.id]
      throw error
    }
    this.schedule(manifest.id, false)
    this.emit()
    void this.run(manifest.id, { reason }).catch((error) => {
      console.error(`Plugin ${manifest.id} background refresh failed`, error)
    })
  }

  async importFile(filePath) {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_PLUGIN_BYTES) throw new PluginEngineError('invalid-file', '插件 JSON 文件无效或超过大小限制')
    const buffer = await fsp.readFile(filePath)
    const manifest = validatePluginManifest(JSON.parse(buffer.toString('utf8')))
    await this.activateManifest(manifest, buffer, 'import')
    return this.publicState()
  }

  async uninstall(pluginId, deleteConfig = false) {
    if (!this.state.installed[pluginId]) return this.publicState()
    this.clearSchedule(pluginId)
    delete this.state.installed[pluginId]
    delete this.state.results[pluginId]
    if (deleteConfig) delete this.state.configs[pluginId]
    this.manifests.delete(pluginId)
    await fsp.rm(path.join(this.packagesRoot, `${pluginId}.json`), { force: true })
    await this.save()
    this.emit()
    return this.publicState()
  }

  async updateConfig(pluginId, config) {
    const manifest = this.manifests.get(pluginId)
    if (!manifest) throw new PluginEngineError('not-installed', '插件尚未安装')
    this.state.configs[pluginId] = sanitizeConfig(manifest, config)
    await this.save()
    this.schedule(pluginId, false)
    this.emit()
    return this.publicState()
  }

  clearSchedule(pluginId) {
    const timer = this.timers.get(pluginId)
    if (timer) clearTimeout(timer)
    this.timers.delete(pluginId)
  }

  schedule(pluginId, startup) {
    this.clearSchedule(pluginId)
    const manifest = this.manifests.get(pluginId)
    if (!manifest) return
    const config = sanitizeConfig(manifest, this.state.configs[pluginId])
    const schedule = manifest.hooks?.schedule || {}
    const mode = config[schedule.modeSetting]
    if (startup && mode === schedule.startupValue) void this.run(pluginId, { reason: 'startup' })
    if (mode !== schedule.intervalValue) return
    const hours = Math.max(.25, Math.min(720, Number(config[schedule.intervalSetting]) || 6))
    const last = Math.max(0, ...Object.values(this.state.results[pluginId] || {}).map((result) => Date.parse(result?.checkedAt || '') || 0))
    const delay = Math.max(2_000, hours * 3_600_000 - Math.max(0, Date.now() - last))
    const timer = setTimeout(async () => {
      this.timers.delete(pluginId)
      await this.run(pluginId, { reason: 'interval' })
      this.schedule(pluginId, false)
    }, delay)
    timer.unref?.()
    this.timers.set(pluginId, timer)
  }

  sessionsChanged() {
    if (this.sessionChangeTimer) clearTimeout(this.sessionChangeTimer)
    this.sessionChangeTimer = setTimeout(() => {
      this.sessionChangeTimer = null
      const validIds = new Set(this.getSessions().map((item) => item.id))
      let changed = false
      for (const pluginId of Object.keys(this.state.results)) {
        for (const sessionId of Object.keys(this.state.results[pluginId] || {})) {
          if (!validIds.has(sessionId)) {
            delete this.state.results[pluginId][sessionId]
            changed = true
          }
        }
      }
      if (changed) void this.save()
      this.emit()
    }, 300)
    this.sessionChangeTimer.unref?.()
  }

  async matchesSession(manifest, browserSession) {
    const hosts = new Set((manifest.hooks?.sessionMatch?.tabHosts || []).map((item) => String(item).toLowerCase()))
    const tabMatch = (browserSession.tabs || []).some((tab) => {
      try {
        const hostname = new URL(tab.url).hostname.toLowerCase()
        return hosts.has(hostname) || [...hosts].some((host) => hostname.endsWith(`.${host}`))
      } catch { return false }
    })
    if (tabMatch) return true
    for (const cookieUrl of manifest.hooks?.sessionMatch?.cookieUrls || []) {
      try {
        const url = new URL(cookieUrl)
        if (!manifest.permissions.hosts.includes(url.origin)) continue
        const cookies = await this.getSession(browserSession.id).cookies.get({ url: url.toString() })
        if (cookies.length) return true
      } catch { /* Cookie presence detection is best effort. */ }
    }
    return false
  }

  async executeRequestStep(manifest, browserSession, step, context) {
    const url = new URL(interpolate(step.request.url, context))
    if (!manifest.permissions.hosts.includes(url.origin)) throw new PluginEngineError('permission-denied', '插件请求超出授权域名')
    const headers = {}
    for (const [key, value] of Object.entries(step.request.headers || {})) headers[key] = interpolate(value, context)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(2_000, Math.min(30_000, Number(step.request.timeoutMs) || 12_000)))
    try {
      const response = await this.getSession(browserSession.id).fetch(url.toString(), {
        method: 'GET', headers, credentials: 'include', redirect: 'follow', signal: controller.signal,
      })
      if (response.status === 401) throw new PluginEngineError('not-logged-in', 'ChatGPT 会话未登录或登录已失效')
      if (response.status === 403) throw new PluginEngineError('account-restricted', '账号无权访问用量信息或账号状态异常')
      if (response.status === 404) throw new PluginEngineError('endpoint-unavailable', '用量接口暂不可用，可能已发生变化')
      if (response.status === 429) throw new PluginEngineError('temporarily-limited', '请求过于频繁，请稍后重试')
      if (!response.ok) throw new PluginEngineError('request-failed', `服务返回 ${response.status}`)
      const text = await response.text()
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new PluginEngineError('response-too-large', '插件接口返回内容过大')
      let body
      try { body = text ? JSON.parse(text) : {} } catch { throw new PluginEngineError('invalid-response', '用量接口返回了无法识别的数据') }
      const result = { status: response.status, body }
      for (const requirement of step.required || []) {
        if (getPath(result, requirement.path) === undefined || getPath(result, requirement.path) === null || getPath(result, requirement.path) === '') {
          throw new PluginEngineError(requirement.code || 'invalid-response', safeString(requirement.message, 240) || '接口缺少必要数据')
        }
      }
      return result
    } catch (error) {
      if (error?.name === 'AbortError') throw new PluginEngineError('timeout', '连接超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async refreshSession(manifest, browserSession) {
    const now = Date.now()
    const context = { steps: {}, session: { id: browserSession.id, name: browserSession.name } }
    for (const step of manifest.hooks.refresh.steps) {
      context.steps[step.id] = await this.executeRequestStep(manifest, browserSession, step, context)
    }
    const fields = {}
    for (const output of manifest.hooks.refresh.outputs || []) {
      const value = transformedOutput(output, context, now)
      if (value !== undefined) fields[output.key] = value
    }
    const classification = classifyResult(manifest, fields)
    if (classification.status === 'ok' && !Number.isFinite(Number(fields.remainingPercent))) {
      throw new PluginEngineError('invalid-response', '未找到可识别的非免费账号用量信息')
    }
    return { status: classification.status, message: classification.message, fields, checkedAt: new Date(now).toISOString(), error: null }
  }

  async run(pluginId, { reason = 'manual' } = {}) {
    if (this.running.has(pluginId)) return this.running.get(pluginId)
    const manifest = this.manifests.get(pluginId)
    if (!manifest) throw new PluginEngineError('not-installed', '插件尚未安装')
    const work = (async () => {
      this.emit()
      const matches = []
      for (const browserSession of this.getSessions()) {
        if (await this.matchesSession(manifest, browserSession)) matches.push(browserSession)
      }
      this.state.results[pluginId] ||= {}
      for (const browserSession of matches) {
        if (!this.state.installed[pluginId]) break
        this.state.results[pluginId][browserSession.id] = { status: 'updating', checkedAt: new Date().toISOString(), error: null, fields: {} }
        this.emit()
        try {
          const result = await this.refreshSession(manifest, browserSession)
          if (this.state.results[pluginId]) this.state.results[pluginId][browserSession.id] = result
        } catch (error) {
          if (this.state.results[pluginId]) this.state.results[pluginId][browserSession.id] = {
            status: 'error', checkedAt: new Date().toISOString(), fields: {}, error: publicError(error),
          }
        }
        await this.save()
        this.emit()
      }
      const matchingIds = new Set(matches.map((item) => item.id))
      for (const sessionId of Object.keys(this.state.results[pluginId] || {})) {
        if (!matchingIds.has(sessionId)) delete this.state.results[pluginId][sessionId]
      }
      await this.save()
      return { ok: true, pluginId, reason, refreshed: matches.length, state: this.publicState() }
    })().finally(() => {
      this.running.delete(pluginId)
      this.emit()
    })
    this.running.set(pluginId, work)
    return work
  }

  dispose() {
    for (const pluginId of [...this.timers.keys()]) this.clearSchedule(pluginId)
    if (this.sessionChangeTimer) clearTimeout(this.sessionChangeTimer)
  }
}

export const pluginInternals = { validatePluginManifest, validateCatalog, sanitizeConfig, transformedOutput }
