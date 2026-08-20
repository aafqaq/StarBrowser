import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [legacyRoot, outputPath] = process.argv.slice(2)
if (!legacyRoot || !outputPath) throw new Error('Usage: node prepare-webview2-cookie-import.mjs <legacy-data-root> <output-json>')

const sqliteExe = 'E:\\Android\\Sdk\\platform-tools\\sqlite3.exe'

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

function sqliteJson(databasePath, sql) {
  const output = execFileSync(sqliteExe, ['-json', databasePath, sql], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  }).trim()
  return output ? JSON.parse(output) : []
}

function sameSite(value) {
  if (Number(value) === 0) return 'no_restriction'
  if (Number(value) === 1) return 'lax'
  if (Number(value) === 2) return 'strict'
  return 'unspecified'
}

function chromeTimeToUnixSeconds(value) {
  return Number(value) / 1_000_000 - 11_644_473_600
}

const state = JSON.parse(await readFile(path.join(legacyRoot, 'state.json'), 'utf8'))
const result = { version: 1, sessions: [] }
let sourceCookies = 0
let eligibleCookies = 0
let failedCookies = 0
const now = Date.now() / 1000

for (const browserSession of state.sessions || []) {
  const webViewRoot = path.join(legacyRoot, 'profiles', browserSession.id, 'EBWebView')
  const databasePath = path.join(webViewRoot, 'Default', 'Network', 'Cookies')
  const localState = JSON.parse(await readFile(path.join(webViewRoot, 'Local State'), 'utf8'))
  const key = masterKey(localState)
  const version = Number(sqliteJson(databasePath, "select value from meta where key='version'")[0]?.value || 0)
  const rows = sqliteJson(databasePath, 'select host_key, name, value, hex(encrypted_value) as encrypted_hex, path, expires_utc, is_secure, is_httponly, has_expires, is_persistent, samesite from cookies')
  const cookies = []
  sourceCookies += rows.length
  for (const row of rows) {
    try {
      const expirationDate = chromeTimeToUnixSeconds(row.expires_utc)
      const persistent = Boolean(Number(row.has_expires)) && Boolean(Number(row.is_persistent))
      if (persistent && (!Number.isFinite(expirationDate) || expirationDate <= now)) continue
      const domain = String(row.host_key || '')
      const encrypted = Buffer.from(String(row.encrypted_hex || ''), 'hex')
      cookies.push({
        name: String(row.name || ''),
        value: String(row.value || decryptCookie(encrypted, key, domain, version)),
        domain,
        hostOnly: !domain.startsWith('.'),
        path: String(row.path || '/'),
        secure: Boolean(Number(row.is_secure)),
        httpOnly: Boolean(Number(row.is_httponly)),
        sameSite: sameSite(row.samesite),
        session: !persistent,
        ...(persistent ? { expirationDate } : {}),
      })
      eligibleCookies += 1
    } catch {
      failedCookies += 1
    }
  }
  result.sessions.push({ id: browserSession.id, cookies })
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(result), 'utf8')
console.log(JSON.stringify({ sessions: result.sessions.length, sourceCookies, eligibleCookies, failedCookies }, null, 2))
