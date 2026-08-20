import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildUpdateUiPowerShell } from '../main/update-service.mjs'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'starbrowser-updater-ui-'))
const worker = path.join(root, 'worker.ps1')
const ui = path.join(root, 'ui.ps1')
const progress = path.join(root, 'progress.json')
const failure = path.join(root, 'failure.log')
const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`
const utf16Script = (source) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])

try {
  const workerSource = `
$progress = ${psLiteral(progress)}
@{ phase = 'installing'; percent = 52; message = 'installing'; detail = '' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $progress -Encoding UTF8 -Force
Start-Sleep -Milliseconds 350
@{ phase = 'success'; percent = 100; message = 'complete'; detail = '' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $progress -Encoding UTF8 -Force
`
  const uiSource = buildUpdateUiPowerShell({ workerScript: worker, progressFile: progress, failureFile: failure, version: '9.9.9' })
  await fsp.writeFile(worker, utf16Script(workerSource))
  await fsp.writeFile(ui, utf16Script(uiSource))
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-WindowStyle', 'Hidden', '-File', ui,
    ], {
      windowsHide: true,
      env: { ...process.env, STARBROWSER_UPDATER_UI_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`更新小窗测试超时\n${output}`))
    }, 15_000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve({ code, output })
    })
  })
  assert.equal(result.code, 0, `更新小窗退出异常：${result.output}`)
  await assert.rejects(fsp.access(progress), '更新小窗完成后应清理进度状态')
  console.log(JSON.stringify({ ok: true, wpfUpdater: true, hiddenDuringTest: true }, null, 2))
} finally {
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
}
