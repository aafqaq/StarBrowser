export interface BrowserTab {
  id: string
  title: string
  url: string
  favicon: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  createdAt: string
}

export interface BrowserSession {
  id: string
  profileName: string
  name: string
  memo: string
  memoTabVisible: boolean
  memoTabIndex: number
  memoActive: boolean
  createdAt: string
  expiresAt: string | null
  recycleAfterDays: number | null
  recycleDaysRemaining: number | null
  recycleLastCheckedDate: string | null
  activeTabId: string
  tabs: BrowserTab[]
}

export interface RecycledSession {
  session: BrowserSession
  deletedAt: string
}

export interface Favorite {
  id: string
  title: string
  url: string
  favicon: string
  folderId: string
  createdAt: string
}

export interface FavoriteFolder {
  id: string
  name: string
  parentId: string
}

export type PerformanceTier = 'low' | 'medium' | 'high'
export type HardwareClass = 'ultra-low' | 'low' | 'balanced' | 'high' | 'ultra-high'
export type MemoryPressureLevel = 'normal' | 'constrained' | 'critical'

export interface AppSettings {
  closeBehavior: 'ask' | 'tray' | 'exit'
  maximizeBehavior: 'maximize' | 'fullscreen'
  sidebarCollapsed: boolean
  performanceTier: HardwareClass
  performanceSelectionSource: 'automatic' | 'manual'
  ignoredUpdateVersion: string
}

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'extracting' | 'downloaded' | 'installing' | 'up-to-date' | 'error' | 'unsupported'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  progress: number
  transferred: number
  total: number
  speed: number
  error: string
  manual: boolean
  candidate: null | {
    version: string
    name: string
    notes: string
    publishedAt: string
    releaseUrl: string
    size: number
    compatibility: {
      stateSchemaVersion?: number
      storageSchemaVersion?: number
      sessionExportFormatVersions?: number[]
      sessionExportAlgorithmVersions?: number[]
      migrations?: Array<Record<string, unknown>>
    }
  }
}

export interface AppState {
  version: number
  activeSessionId: string
  sessions: BrowserSession[]
  recycleBin: RecycledSession[]
  favorites: Favorite[]
  favoriteFolders: FavoriteFolder[]
  settings: AppSettings
}

export interface PluginSettingSchema {
  key: string
  label: string
  description: string
  type: 'select' | 'number' | 'boolean'
  default: string | number | boolean
  minimum?: number
  maximum?: number
  step?: number
  options?: Array<{ label: string; value: string | number }>
  visibleWhen?: { key: string; equals: string | number | boolean }
}

export interface PluginCatalogEntry {
  id: string
  version: string
  name: string
  description: string
  publisher: string
  icon: string
}

export interface InstalledPlugin extends PluginCatalogEntry {
  settingsSchema: PluginSettingSchema[]
  sessionBadges: Array<{
    whenStatus: PluginSessionResult['status']
    label?: string
    field?: string
    format?: string
    type?: 'default' | 'success' | 'warning' | 'error' | 'info'
    typeThresholds?: Array<{ minimum: number; type: 'default' | 'success' | 'warning' | 'error' | 'info' }>
    visibleWhen?: { field: string; operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number }
    tooltipField?: string
  }>
  config: Record<string, string | number | boolean>
  installedAt: string
  loadError: string
  running: boolean
  updateAvailable: boolean
  availableVersion: string
}

export interface PluginSessionResult {
  status: 'updating' | 'ok' | 'not-applicable' | 'error'
  message?: string
  fields: Record<string, string | number | boolean>
  checkedAt: string
  error: null | { code: string; message: string }
}

export interface PluginEngineState {
  catalog: PluginCatalogEntry[]
  installed: InstalledPlugin[]
  results: Record<string, Record<string, PluginSessionResult>>
}

export interface ElectronApi {
  state: {
    get(): Promise<AppState>
    update(state: AppState): void
  }
  browser: {
    clearSession(sessionId: string): Promise<void>
    exportSession(sessionId: string, password: string): Promise<{ ok: boolean; canceled?: boolean; error?: string; code?: string; filePath?: string; stats?: { storageBytes?: number; fileCount?: number; cookieCount?: number; formatVersion?: number; algorithmVersion?: number } }>
    importSession(password: string): Promise<{ ok: boolean; canceled?: boolean; error?: string; code?: string; session?: BrowserSession; stats?: { storageBytes?: number; fileCount?: number; cookieCount?: number; formatVersion?: number; algorithmVersion?: number } }>
    applyPerformance(payload: { activeGuestId: number; guestIds: number[]; activeFrameRate: number; backgroundFrameRate: number }): void
    onNewWindow(callback: (payload: { url: string }) => void): () => void
    onCommand(callback: (command: string) => void): () => void
  }
  window: {
    control(action: 'minimize' | 'maximize' | 'close'): void
    onChanged(callback: (state: { maximized: boolean; fullscreen: boolean }) => void): () => void
  }
  app: {
    onCloseRequest(callback: () => void): () => void
    closeChoice(choice: { action: 'tray' | 'exit'; remember: boolean }): void
  }
  update: {
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<UpdateStatus>
    install(): Promise<{ ok: boolean }>
    ignore(version: string): Promise<boolean>
    onStatus(callback: (status: UpdateStatus) => void): () => void
    simulateForSmoke(): Promise<UpdateStatus>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): void
  }
  shell: {
    open(url: string): Promise<void>
  }
  time: {
    sync(): Promise<{ ok: boolean; now?: number; source?: string; error?: string }>
  }
  system: {
    performanceProfile(): Promise<{ tier: PerformanceTier; hardwareClass: HardwareClass; hardwareScore: number; totalMemoryGB: number; logicalCpuCount: number; averageCpuMHz: number }>
    memoryStatus(): Promise<{ level: MemoryPressureLevel; freeMemoryGB: number; usedPercent: number; appWorkingSetMB: number }>
  }
  plugins: {
    getState(): Promise<PluginEngineState>
    refreshCatalog(): Promise<PluginEngineState>
    install(pluginId: string): Promise<PluginEngineState>
    import(): Promise<{ canceled?: boolean; state: PluginEngineState }>
    uninstall(pluginId: string, deleteConfig: boolean): Promise<PluginEngineState>
    updateConfig(pluginId: string, config: Record<string, string | number | boolean>): Promise<PluginEngineState>
    run(pluginId: string): Promise<{ ok: boolean; refreshed: number; state: PluginEngineState }>
    onState(callback: (state: PluginEngineState) => void): () => void
  }
}
