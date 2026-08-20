import { parentPort, workerData } from 'node:worker_threads'
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib'
import fsp from 'node:fs/promises'
import path from 'node:path'

const scrypt = promisify(scryptCallback)
const gzip = promisify(gzipCallback)
const gunzip = promisify(gunzipCallback)
const MAGIC = Buffer.from('SBSESSN1', 'ascii')
const FORMAT_VERSION = 1
const ALGORITHM_VERSION = 1
const HEADER_WITHOUT_TAG_SIZE = 40
const HEADER_SIZE = 56
const MAX_STORAGE_BYTES = 512 * 1024 * 1024
const STORAGE_ROOTS = new Set(['Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'databases', 'File System'])

function transferError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function deriveKey(password, salt) {
  return Buffer.from(await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }))
}

function safeRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..') || !STORAGE_ROOTS.has(parts[0]) || parts.at(-1) === 'LOCK') {
    throw transferError('INVALID_ARCHIVE_PATH', '会话包包含不安全的存储路径')
  }
  return parts.join(path.sep)
}

async function collectDirectory(rootPath, relativeRoot, files, byteCounter) {
  const absoluteRoot = path.join(rootPath, relativeRoot)
  let entries
  try {
    entries = await fsp.readdir(absoluteRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.name === 'LOCK') continue
    const relativePath = path.join(relativeRoot, entry.name)
    if (entry.isDirectory()) {
      await collectDirectory(rootPath, relativePath, files, byteCounter)
      continue
    }
    if (!entry.isFile()) continue
    const data = await fsp.readFile(path.join(rootPath, relativePath))
    byteCounter.value += data.length
    if (byteCounter.value > MAX_STORAGE_BYTES) throw transferError('STORAGE_TOO_LARGE', '凭证类存储超过 512MB，已停止导出')
    files.push({ path: relativePath.replaceAll('\\', '/'), data: data.toString('base64') })
  }
}

async function collectStorage(storagePath) {
  const files = []
  const byteCounter = { value: 0 }
  for (const relativeRoot of STORAGE_ROOTS) await collectDirectory(storagePath, relativeRoot, files, byteCounter)
  return { files, bytes: byteCounter.value }
}

async function encryptArchive(payload, password) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(password, salt)
  const compressed = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 })
  const header = Buffer.alloc(HEADER_WITHOUT_TAG_SIZE)
  MAGIC.copy(header, 0)
  header.writeUInt16BE(FORMAT_VERSION, 8)
  header.writeUInt16BE(ALGORITHM_VERSION, 10)
  salt.copy(header, 12)
  iv.copy(header, 28)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()])
  return Buffer.concat([header, cipher.getAuthTag(), encrypted])
}

async function decryptArchive(archive, password) {
  if (archive.length < HEADER_SIZE || !archive.subarray(0, 8).equals(MAGIC)) {
    throw transferError('INVALID_ARCHIVE', '不是有效的 StarBrowser 会话包')
  }
  const formatVersion = archive.readUInt16BE(8)
  const algorithmVersion = archive.readUInt16BE(10)
  if (formatVersion !== FORMAT_VERSION) throw transferError('INCOMPATIBLE_FORMAT_VERSION', `当前版本不支持会话包格式 v${formatVersion}`)
  if (algorithmVersion !== ALGORITHM_VERSION) throw transferError('INCOMPATIBLE_ALGORITHM_VERSION', `当前版本不支持加密算法 v${algorithmVersion}`)
  const header = archive.subarray(0, HEADER_WITHOUT_TAG_SIZE)
  const salt = archive.subarray(12, 28)
  const iv = archive.subarray(28, 40)
  const authTag = archive.subarray(40, HEADER_SIZE)
  const encrypted = archive.subarray(HEADER_SIZE)
  try {
    const key = await deriveKey(password, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(header)
    decipher.setAuthTag(authTag)
    const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const payload = JSON.parse((await gunzip(compressed)).toString('utf8'))
    if (payload?.formatVersion !== FORMAT_VERSION || payload?.algorithmVersion !== ALGORITHM_VERSION || !payload?.session) {
      throw transferError('INVALID_ARCHIVE', '会话包内容不完整')
    }
    return payload
  } catch (error) {
    if (error?.code) throw error
    throw transferError('WRONG_PASSWORD_OR_CORRUPT', '密码错误或会话包已损坏')
  }
}

async function restoreStorage(storagePath, files) {
  let restoredBytes = 0
  for (const file of Array.isArray(files) ? files : []) {
    const relativePath = safeRelativePath(file?.path)
    const targetPath = path.resolve(storagePath, relativePath)
    const resolvedRoot = `${path.resolve(storagePath)}${path.sep}`
    if (!targetPath.startsWith(resolvedRoot)) throw transferError('INVALID_ARCHIVE_PATH', '会话包路径越界')
    const data = Buffer.from(String(file?.data || ''), 'base64')
    restoredBytes += data.length
    if (restoredBytes > MAX_STORAGE_BYTES) throw transferError('STORAGE_TOO_LARGE', '会话包凭证类存储超过 512MB')
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    await fsp.writeFile(targetPath, data)
  }
  return restoredBytes
}

async function run() {
  if (workerData.operation === 'export') {
    const storage = await collectStorage(workerData.storagePath)
    const payload = {
      formatVersion: FORMAT_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      exportedAt: new Date().toISOString(),
      session: workerData.session,
      cookies: workerData.cookies,
      storageFiles: storage.files,
    }
    const archive = await encryptArchive(payload, workerData.password)
    await fsp.writeFile(workerData.archivePath, archive)
    return { storageBytes: storage.bytes, fileCount: storage.files.length, archiveBytes: archive.length, formatVersion: FORMAT_VERSION, algorithmVersion: ALGORITHM_VERSION }
  }
  if (workerData.operation === 'import') {
    const archive = await fsp.readFile(workerData.archivePath)
    const payload = await decryptArchive(archive, workerData.password)
    const storageBytes = await restoreStorage(workerData.storagePath, payload.storageFiles)
    return { payload: { session: payload.session, cookies: payload.cookies }, storageBytes, fileCount: payload.storageFiles?.length || 0, formatVersion: FORMAT_VERSION, algorithmVersion: ALGORITHM_VERSION }
  }
  throw transferError('INVALID_OPERATION', '未知的会话包操作')
}

run().then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error) => parentPort?.postMessage({ ok: false, error: { code: error?.code || 'TRANSFER_FAILED', message: error?.message || String(error) } }),
)
