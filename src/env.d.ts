/// <reference types="vite/client" />

import type { ElectronApi } from './types'

declare global {
  interface StarBrowserWebviewElement extends HTMLElement {
    src: string
    partition: string
    getWebContentsId(): number
    getURL(): string
    getTitle(): string
    loadURL(url: string): Promise<void>
    reload(): void
    stop(): void
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
    focus(): void
  }

  interface Window {
    starbrowser: ElectronApi
    __starbrowserTest?: {
      getTabOrder(): string[]
      reorderTabs(fromIndex: number, toIndex: number): boolean
      targetTabIndex(floatingLeft: number, listLeft: number, slotWidth: number, tabCount: number): number
      minuteIso(value: number | null): string | null
      getHeaderOrder(): string[]
      reorderHeaderItems(fromIndex: number, toIndex: number): boolean
      memoRoundTrip(): Promise<{ before: number; during: number; after: number; retained: boolean; layout: { editorHeight: number; wrapperHeight: number; textareaHeight: number; aligned: boolean } }>
      sessionSwitchTabOverlap(): Promise<{ expected: number; finalCount: number; maxCount: number; noOverlap: boolean }>
      favoritesFlatCheck(): boolean
      expiryBadgeCheck(): Promise<{ days: number; visible: boolean }>
      neverRecycleCheck(): Promise<boolean>
      prepareRecycleOverlayCheck(): Promise<string>
      cleanupRecycleOverlayCheck(sessionId: string): Promise<boolean>
      prepareShowcase(): Promise<boolean>
      showUpdateShowcase(): Promise<{ visible: boolean; width: number; height: number; title: string }>
      showSettingsShowcase(): Promise<boolean>
      activateTabAt(index: number): Promise<string>
      performancePolicyCheck(): Promise<{ lowLiveTabs: number; lowLiveSessions: number; lowDomGuests: number; mediumBudget: number; highBudget: number; ultraHighBudget: number; fixedUnderCritical: boolean; recommendedTier: string; lowVisualMode: boolean; restoredMode: boolean }>
    }
  }

  interface HTMLElementTagNameMap {
    webview: StarBrowserWebviewElement
  }
}

export {}
