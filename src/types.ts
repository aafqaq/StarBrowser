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
  availableAt: string | null
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
}
