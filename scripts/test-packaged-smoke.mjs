import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.platform !== 'win32') throw new Error('Packaged smoke test requires Windows')

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'starbrowser-packaged-smoke-'))
const executable = path.resolve('dist', 'StarBrowser.exe')
const resultFile = path.join(root, 'data', 'smoke-result.json')
let child = null

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

try {
  if (!fs.existsSync(executable)) throw new Error('Run npm run dist before the packaged smoke test')
  child = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, STARBROWSER_SMOKE: '1', STARBROWSER_TEST_ROOT: root },
  })
  const deadline = Date.now() + 120_000
  while (!fs.existsSync(resultFile) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited before writing its smoke result (${child.exitCode})`)
    await delay(200)
  }
  if (!fs.existsSync(resultFile)) throw new Error('Packaged smoke test timed out')
  const report = JSON.parse(await fsp.readFile(resultFile, 'utf8'))
  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2))
    throw new Error(report.error || 'Packaged smoke test failed')
  }
  if (!report.transferArchive?.quotaManagerRestored || !report.transferArchive?.configuredAfterRestore) {
    throw new Error('QuotaManager was not restored before the Chromium partition started')
  }
  if (!report.transferArchive?.failedImportClean || !report.transferArchive?.wrongPasswordRejected) {
    throw new Error('Failed session import left partial storage behind')
  }
  console.log(JSON.stringify({
    ok: true,
    packaged: report.packaged,
    windowWasVisible: report.windowWasVisible,
    quotaManagerRestored: report.transferArchive.quotaManagerRestored,
    configuredAfterRestore: report.transferArchive.configuredAfterRestore,
    failedImportClean: report.transferArchive.failedImportClean,
  }, null, 2))
} finally {
  if (child && child.exitCode === null) child.kill()
  await delay(500)
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
}
