import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const [archivePath, outputPath] = process.argv.slice(2)
if (!archivePath || !outputPath) throw new Error('用法：node scripts/create-update-manifest.mjs <zip> <latest.json>')
const archive = await readFile(path.resolve(archivePath))
const archiveStats = await stat(path.resolve(archivePath))
const name = path.basename(archivePath)
const version = packageJson.version
const manifest = {
  manifestVersion: 1,
  version,
  publishedAt: new Date().toISOString(),
  asset: {
    name,
    url: `https://github.com/aafqaq/StarBrowser/releases/download/v${version}/${name}`,
    size: archiveStats.size,
    sha256: createHash('sha256').update(archive).digest('hex'),
  },
  compatibility: {
    stateSchemaVersion: 1,
    storageSchemaVersion: 1,
    sessionExportFormatVersions: [1],
    sessionExportAlgorithmVersions: [1],
    migrations: [],
  },
}
await writeFile(path.resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`更新清单已生成：${outputPath}`)
