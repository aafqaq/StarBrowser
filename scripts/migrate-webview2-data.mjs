import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [legacyRoot, targetRoot] = process.argv.slice(2)
if (!legacyRoot || !targetRoot) {
  throw new Error('Usage: node migrate-webview2-data.mjs <legacy-data-root> <target-data-root>')
}

const storageRoots = ['Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'databases', 'File System']
const sqliteExe = 'E:\\Android\\Sdk\\platform-tools\\sqlite3.exe'
const legacyStatePath = path.join(legacyRoot, 'state.json')
const targetStatePath = path.join(targetRoot, 'state.json')
const legacyState = JSON.parse(await readFile(legacyStatePath, 'utf8'))

function normalizeTab(tab) {
  return {
    id: String(tab?.id || crypto.randomUUID().replaceAll('-', '')),
    title: String(tab?.title || '新标签页'),
    url: String(tab?.url || 'https://www.bing.com/'),
    favicon: String(tab?.iconUrl || tab?.favicon || ''),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: String(tab?.createdAt || new Date().toISOString()),
  }
}

function normalizeSession(session) {
  const tabs = Array.isArray(session?.tabs) && session.tabs.length
    ? session.tabs.map(normalizeTab)
    : [normalizeTab({})]
  const activeTabId = tabs.some((tab) => tab.id === session?.activeTabId) ? session.activeTabId : tabs[0].id
  return {
    id: String(session?.id || crypto.randomUUID().replaceAll('-', '')),
    profileName: `session_${String(session?.id || crypto.randomUUID().replaceAll('-', ''))}`,
    name: String(session?.note || session?.name || '未命名会话'),
    memo: String(session?.memo || ''),
    memoTabVisible: Boolean(session?.memoTabVisible),
    memoTabIndex: Number.isFinite(Number(session?.memoTabIndex)) ? Math.max(0, Math.min(tabs.length, Number(session.memoTabIndex))) : tabs.length,
    memoActive: false,
    createdAt: String(session?.createdAt || new Date().toISOString()),
    ...(session?.availableAt ? { availableAt: String(session.availableAt) } : {}),
    ...(session?.expiresAt ? { expiresAt: String(session.expiresAt) } : {}),
    activeTabId,
    tabs,
  }
}

const sessions = (Array.isArray(legacyState.sessions) ? legacyState.sessions : []).map(normalizeSession)
if (!sessions.length) throw new Error('Legacy state contains no sessions')

const legacyFavorites = Array.isArray(legacyState.favorites) ? legacyState.favorites : []
const folderIds = new Set(legacyFavorites.filter((item) => item?.type === 'folder').map((item) => String(item.id)))
const favoriteFolders = legacyFavorites
  .filter((item) => item?.type === 'folder')
  .map((item) => ({
    id: String(item.id || crypto.randomUUID().replaceAll('-', '')),
    name: String(item.title || '新建文件夹'),
    parentId: folderIds.has(String(item.parentId || '')) ? String(item.parentId) : '',
  }))
const favorites = legacyFavorites
  .filter((item) => item?.type !== 'folder')
  .map((item) => ({
    id: String(item.id || crypto.randomUUID().replaceAll('-', '')),
    title: String(item.title || '未命名收藏'),
    url: String(item.url || 'https://www.bing.com/'),
    favicon: String(item.iconUrl || item.favicon || ''),
    folderId: folderIds.has(String(item.parentId || '')) ? String(item.parentId) : '',
    createdAt: String(item.createdAt || new Date().toISOString()),
  }))

const state = {
  version: 1,
  activeSessionId: sessions.some((item) => item.id === legacyState.activeSessionId) ? legacyState.activeSessionId : sessions[0].id,
  sessions,
  recycleBin: [],
  favorites,
  favoriteFolders,
  settings: {
    closeBehavior: ['ask', 'tray', 'exit'].includes(legacyState.settings?.closeBehavior) ? legacyState.settings.closeBehavior : 'ask',
    maximizeBehavior: legacyState.settings?.maximizeBehavior === 'fullscreen' ? 'fullscreen' : 'maximize',
    sidebarCollapsed: Boolean(legacyState.settings?.sidebarCollapsed),
    performanceTier: 'balanced',
    performanceSelectionSource: 'automatic',
  },
}

async function copyStorageTree(source, target) {
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: 0, bytes: 0 }
    throw error
  }
  let files = 0
  let bytes = 0
  await mkdir(target, { recursive: true })
  for (const entry of entries) {
    if (entry.name === 'LOCK') continue
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      const child = await copyStorageTree(sourcePath, targetPath)
      files += child.files
      bytes += child.bytes
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath)
      const data = await readFile(sourcePath)
      files += 1
      bytes += data.length
    }
  }
  return { files, bytes }
}

await mkdir(targetRoot, { recursive: true })
await rm(path.join(targetRoot, 'electron'), { recursive: true, force: true })

let storageFiles = 0
let storageBytes = 0
for (const session of sessions) {
  const sourceProfile = path.join(legacyRoot, 'profiles', session.id, 'EBWebView', 'Default')
  const targetPartition = path.join(targetRoot, 'electron', 'session-data', 'Partitions', `starbrowser_${session.id}`)
  for (const root of storageRoots) {
    const result = await copyStorageTree(path.join(sourceProfile, root), path.join(targetPartition, root))
    storageFiles += result.files
    storageBytes += result.bytes
  }
}

await writeFile(targetStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

function dpapiUnprotect(buffer) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$inputBytes = [Convert]::FromBase64String('${buffer.toString('base64')}')`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($plain)',
  ].join('; ')
  return Buffer.from(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim(), 'base64')
}

function masterKey(localState) {
  const protectedKey = Buffer.from(localState.os_crypt.encrypted_key, 'base64')
  const payload = protectedKey.subarray(0, 5).toString('ascii') === 'DPAPI' ? protectedKey.subarray(5) : protectedKey
  return dpapiUnprotect(payload)
}

function decryptCookie(encrypted, key, host, dbVersion) {
  if (!encrypted.length) return ''
  if (!encrypted.subarray(0, 3).equals(Buffer.from('v10'))) return dpapiUnprotect(encrypted).toString('utf8')
  const nonce = encrypted.subarray(3, 15)
  const payload = encrypted.subarray(15)
  const tag = payload.subarray(payload.length - 16)
  const ciphertext = payload.subarray(0, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let clear = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (dbVersion >= 24 && clear.length >= 32) {
    const expected = createHash('sha256').update(host).digest()
    if (clear.subarray(0, 32).equals(expected)) clear = clear.subarray(32)
  }
  return clear.toString('utf8')
}

function encryptCookie(value, key, host, dbVersion) {
  const nonce = randomBytes(12)
  const prefix = dbVersion >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), nonce, encrypted, cipher.getAuthTag()])
}

function sqliteJson(databasePath, sql) {
  const output = execFileSync(sqliteExe, ['-json', databasePath, sql], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
  return output ? JSON.parse(output) : []
}

const electronRoot = path.join(targetRoot, 'electron', 'session-data')
const targetLocalStateSource = JSON.parse(await readFile(path.resolve('dist/data/electron/session-data/Local State'), 'utf8'))
const targetLocalState = { os_crypt: targetLocalStateSource.os_crypt }
await mkdir(electronRoot, { recursive: true })
await writeFile(path.join(electronRoot, 'Local State'), JSON.stringify(targetLocalState), 'utf8')
const targetKey = masterKey(targetLocalState)
let cookiesRead = 0
let cookiesImported = 0
let cookiesSkipped = 0

for (const browserSession of sessions) {
  const sourceWebViewRoot = path.join(legacyRoot, 'profiles', browserSession.id, 'EBWebView')
  const sourceDatabase = path.join(sourceWebViewRoot, 'Default', 'Network', 'Cookies')
  const targetNetwork = path.join(electronRoot, 'Partitions', `starbrowser_${browserSession.id}`, 'Network')
  const targetDatabase = path.join(targetNetwork, 'Cookies')
  await mkdir(targetNetwork, { recursive: true })
  await copyFile(sourceDatabase, targetDatabase)

  const sourceLocalState = JSON.parse(await readFile(path.join(sourceWebViewRoot, 'Local State'), 'utf8'))
  const sourceKey = masterKey(sourceLocalState)
  const versionRows = sqliteJson(sourceDatabase, "select value from meta where key='version'")
  const dbVersion = Number(versionRows[0]?.value || 0)
  const rows = sqliteJson(sourceDatabase, 'select rowid, host_key, value, hex(encrypted_value) as encrypted_hex from cookies')
  cookiesRead += rows.length
  const statements = ['begin immediate;']
  for (const row of rows) {
    try {
      const oldEncrypted = Buffer.from(String(row.encrypted_hex || ''), 'hex')
      const value = String(row.value || decryptCookie(oldEncrypted, sourceKey, String(row.host_key || ''), dbVersion))
      const newEncrypted = encryptCookie(value, targetKey, String(row.host_key || ''), dbVersion)
      statements.push(`update cookies set value='', encrypted_value=X'${newEncrypted.toString('hex')}' where rowid=${Number(row.rowid)};`)
      cookiesImported += 1
    } catch {
      statements.push(`delete from cookies where rowid=${Number(row.rowid)};`)
      cookiesSkipped += 1
    }
  }
  statements.push('commit;')
  execFileSync(sqliteExe, [targetDatabase], {
    input: statements.join('\n'),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
}

console.log(JSON.stringify({
  sessions: sessions.length,
  tabs: sessions.reduce((total, item) => total + item.tabs.length, 0),
  favorites: favorites.length,
  favoriteFolders: favoriteFolders.length,
  storageFiles,
  storageBytes,
  cookiesRead,
  cookiesImported,
  cookiesSkipped,
}, null, 2))
