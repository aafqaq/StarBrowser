import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }
import { createRuntimeId } from '../main/update-service.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(projectRoot, 'dist')
const distEntries = await readdir(distRoot, { withFileTypes: true })
if (distEntries.some((entry) => entry.name.toLowerCase() === 'data')) {
  throw new Error('拒绝生成发行清单：dist 中包含用户 data 目录')
}
const ownedTopLevel = distEntries
  .map((entry) => entry.name)
  .filter((name) => name !== 'data' && name !== 'starbrowser-update.json')
  .sort((left, right) => left.localeCompare(right, 'en'))
ownedTopLevel.push('starbrowser-update.json')

const manifest = {
  manifestVersion: 2,
  version: packageJson.version,
  runtimeId: createRuntimeId(packageJson.devDependencies.electron, 'win32', 'x64'),
  ownedTopLevel,
}
await writeFile(path.join(distRoot, 'starbrowser-update.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`程序文件清单已生成，共 ${ownedTopLevel.length} 个顶层条目。`)
