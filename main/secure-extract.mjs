import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { updateFs, updateFsp } from './update-filesystem.mjs'


function openArchive(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error) reject(error)
      else resolve(archive)
    })
  })
}

function openEntryStream(archive, entry) {
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
}

function safeEntryPath(root, fileName) {
  const normalized = String(fileName || '').replace(/\\/g, '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('ZIP 包含绝对路径')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) throw new Error('ZIP 包含越界路径')
  const destination = path.resolve(root, ...segments)
  const rootPrefix = `${path.resolve(root)}${path.sep}`.toLowerCase()
  if (!destination.toLowerCase().startsWith(rootPrefix)) throw new Error('ZIP 解压路径越界')
  return destination
}

export async function secureExtractZip(archivePath, destinationRoot, { maxFiles = 50_000, maxUncompressedBytes = 3 * 1024 ** 3 } = {}) {
  const root = path.resolve(destinationRoot)
  await updateFsp.mkdir(root, { recursive: true })
  const archive = await openArchive(path.resolve(archivePath))
  return new Promise((resolve, reject) => {
    let fileCount = 0
    let totalBytes = 0
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (error) {
        try { archive.close() } catch { /* already closed */ }
        reject(error)
      } else resolve(result)
    }
    archive.once('error', (error) => finish(error))
    archive.once('end', () => finish(null, { fileCount, totalBytes }))
    archive.on('entry', (entry) => {
      void (async () => {
        const destination = safeEntryPath(root, entry.fileName)
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
        if (unixType === 0o120000) throw new Error('ZIP 不允许包含符号链接')
        totalBytes += Number(entry.uncompressedSize) || 0
        if (totalBytes > maxUncompressedBytes) throw new Error('ZIP 解压总量超过安全限制')
        if (/\/$/.test(entry.fileName)) {
          await updateFsp.mkdir(destination, { recursive: true })
        } else {
          fileCount += 1
          if (fileCount > maxFiles) throw new Error('ZIP 文件数量超过安全限制')
          await updateFsp.mkdir(path.dirname(destination), { recursive: true })
          const input = await openEntryStream(archive, entry)
          await pipeline(input, updateFs.createWriteStream(destination, { flags: 'wx' }))
        }
        archive.readEntry()
      })().catch((error) => finish(error))
    })
    archive.readEntry()
  })
}
