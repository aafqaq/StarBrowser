const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('starbrowser', {
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    update: (state) => ipcRenderer.send('state:update', state),
  },
  browser: {
    clearSession: (sessionId) => ipcRenderer.invoke('browser:clear-session', sessionId),
    exportSession: (sessionId, password) => ipcRenderer.invoke('browser:export-session', { sessionId, password }),
    importSession: (password) => ipcRenderer.invoke('browser:import-session', { password }),
    preconnect: (sessionId, url) => ipcRenderer.invoke('browser:preconnect', { sessionId, url }),
    applyPerformance: (payload) => ipcRenderer.send('browser:apply-performance', payload),
    onNewWindow: (callback) => on('browser:new-window', callback),
    onCommand: (callback) => on('browser:command', callback),
  },
  window: {
    control: (action) => ipcRenderer.send('window:control', action),
    onChanged: (callback) => on('window:changed', callback),
  },
  app: {
    onCloseRequest: (callback) => on('app:close-request', callback),
    closeChoice: (choice) => ipcRenderer.send('app:close-choice', choice),
  },
  update: {
    getStatus: () => ipcRenderer.invoke('update:get-status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    ignore: (version) => ipcRenderer.invoke('update:ignore', version),
    onStatus: (callback) => on('update:status', callback),
    simulateForSmoke: () => ipcRenderer.invoke('update:smoke-available'),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:read'),
    writeText: (text) => ipcRenderer.send('clipboard:write', text),
  },
  shell: {
    open: (url) => ipcRenderer.invoke('shell:open', url),
  },
  time: {
    sync: () => ipcRenderer.invoke('time:sync'),
  },
  system: {
    performanceProfile: () => ipcRenderer.invoke('system:performance-profile'),
    memoryStatus: () => ipcRenderer.invoke('system:memory-status'),
  },
  plugins: {
    getState: () => ipcRenderer.invoke('plugins:get-state'),
    refreshCatalog: () => ipcRenderer.invoke('plugins:refresh-catalog'),
    install: (pluginId) => ipcRenderer.invoke('plugins:install', pluginId),
    import: () => ipcRenderer.invoke('plugins:import'),
    uninstall: (pluginId, deleteConfig) => ipcRenderer.invoke('plugins:uninstall', { pluginId, deleteConfig }),
    updateConfig: (pluginId, config) => ipcRenderer.invoke('plugins:update-config', { pluginId, config }),
    run: (pluginId) => ipcRenderer.invoke('plugins:run', pluginId),
    onState: (callback) => on('plugins:state', callback),
  },
})
