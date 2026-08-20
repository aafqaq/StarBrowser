import { readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(projectRoot, 'dist')
const unpackedRoot = path.join(distRoot, 'win-unpacked')

// electron-builder keeps unrelated files already present in its output root.
// A portable build must never inherit a locally generated data directory (or
// any other stale artifact), so retain only this build's fresh unpacked tree.
for (const entry of await readdir(distRoot, { withFileTypes: true })) {
  if (entry.name === 'win-unpacked') continue
  await rm(path.join(distRoot, entry.name), { recursive: true, force: true })
}

for (const entry of await readdir(unpackedRoot, { withFileTypes: true })) {
  const source = path.join(unpackedRoot, entry.name)
  const target = path.join(distRoot, entry.name)
  await rm(target, { recursive: true, force: true })
  await rename(source, target)
}
await rm(unpackedRoot, { recursive: true, force: true })

console.log(`主程序已整理到：${path.join(distRoot, 'StarBrowser.exe')}`)
