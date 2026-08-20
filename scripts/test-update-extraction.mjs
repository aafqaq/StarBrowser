import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { secureExtractZip } from '../main/secure-extract.mjs'

const require = createRequire(import.meta.url)
const rawFs = require('original-fs')
const rawFsp = rawFs.promises
const temporaryRoot = await rawFsp.mkdtemp(path.join(os.tmpdir(), 'starbrowser-asar-extract-'))
const sourceRoot = path.join(temporaryRoot, 'source')
const archivePath = path.join(temporaryRoot, 'update.zip')
const destinationRoot = path.join(temporaryRoot, 'payload')
const fixture = Buffer.from('StarBrowser ASAR extraction regression fixture\n', 'utf8')

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`创建测试 ZIP 失败（${code}）\n${output}`)))
  })
}

let failure = null
try {
  if (!process.versions.electron) throw new Error('此测试必须在 Electron 文件系统补丁环境中运行')
  await rawFsp.mkdir(path.join(sourceRoot, 'resources'), { recursive: true })
  await rawFsp.writeFile(path.join(sourceRoot, 'resources', 'app.asar'), fixture)
  const sourceLiteral = sourceRoot.replaceAll("'", "''")
  const archiveLiteral = archivePath.replaceAll("'", "''")
  await runPowerShell(`Compress-Archive -Path (Join-Path '${sourceLiteral}' '*') -DestinationPath '${archiveLiteral}' -CompressionLevel Optimal`)
  const result = await secureExtractZip(archivePath, destinationRoot)
  const extracted = await rawFsp.readFile(path.join(destinationRoot, 'resources', 'app.asar'))
  if (!extracted.equals(fixture) || result.fileCount !== 1) throw new Error('ASAR 解压内容或文件计数不一致')
  console.log(JSON.stringify({ ok: true, electron: process.versions.electron, appAsarBytes: extracted.length }, null, 2))
} catch (error) {
  failure = error
  console.error(error instanceof Error ? error.stack || error.message : String(error))
} finally {
  await rawFsp.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

process.exit(failure ? 1 : 0)
