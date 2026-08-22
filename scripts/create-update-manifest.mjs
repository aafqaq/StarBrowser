import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { createRuntimeId } from '../main/update-service.mjs'

const [fullArchivePath, appArchivePath, outputPath] = process.argv.slice(2)
if (!fullArchivePath || !appArchivePath || !outputPath) {
  throw new Error('用法：node scripts/create-update-manifest.mjs <full.zip> <app.zip> <latest.json>')
}

async function describeArchive(archivePath, kind, runtimeId = '') {
  const resolved = path.resolve(archivePath)
  const [archive, archiveStats] = await Promise.all([readFile(resolved), stat(resolved)])
  const name = path.basename(resolved)
  return {
    kind,
    name,
    url: `https://github.com/aafqaq/StarBrowser/releases/download/v${packageJson.version}/${name}`,
    size: archiveStats.size,
    sha256: createHash('sha256').update(archive).digest('hex'),
    ...(runtimeId ? { runtimeId } : {}),
  }
}

const version = packageJson.version
const runtimeId = createRuntimeId(packageJson.devDependencies.electron, 'win32', 'x64')
const [full, app] = await Promise.all([
  describeArchive(fullArchivePath, 'full'),
  describeArchive(appArchivePath, 'app', runtimeId),
])
const manifest = {
  manifestVersion: 2,
  version,
  publishedAt: new Date().toISOString(),
  // Legacy updaters only understand `asset`. Point it at the complete package
  // so the transition to dual-channel updates is always safe.
  asset: full,
  assets: { app, full },
  compatibility: {
    stateSchemaVersion: 1,
    storageSchemaVersion: 1,
    sessionExportFormatVersions: [1],
    sessionExportAlgorithmVersions: [1],
    migrations: [],
  },
}
await writeFile(path.resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`双通道更新清单已生成：轻量包 ${Math.ceil(app.size / 1024)} KB，完整包 ${Math.ceil(full.size / 1024 / 1024)} MB。`)
