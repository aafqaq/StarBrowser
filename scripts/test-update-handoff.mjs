import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildUpdateUiPowerShell } from '../main/update-service.mjs'

// This is intentionally a detached-process test.  The real Electron process
// exits immediately after the worker acknowledges the handoff, so a test that
// keeps the parent alive would miss the exact regression reported by users.
// Include spaces and a quote in the temporary root: portable installs can
// live in user-selected paths; the encoded hidden bootstrap must remain safe.
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "starbrowser update handoff-quote-'"))
const workerScript = path.join(root, 'worker.ps1')
const uiScript = path.join(root, 'monitor.ps1')
const launcherScript = path.join(root, 'launch-worker.mjs')
const workerLauncher = path.join(root, 'launch-worker.vbs')
const monitorLauncher = path.join(root, 'launch-monitor.vbs')
const handoffFile = path.join(root, 'handoff.ready')
const progressFile = path.join(root, 'progress.json')
const failureFile = path.join(root, 'failure.log')
const psPath = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'
const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`
const utf16Script = (source) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])

async function waitForFile(file, timeoutMs = 8_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return false
}

async function waitForMissingFile(file, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!fs.existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return false
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill() } catch { }
      reject(new Error('更新器测试进程超时'))
    }, timeoutMs)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

try {
  const workerSource = `
$handoff = ${psLiteral(handoffFile)}
$workerPid = Join-Path (Split-Path -Parent $handoff) 'worker.pid'
$progress = ${psLiteral(progressFile)}
$failure = ${psLiteral(failureFile)}
New-Item -ItemType Directory -Path (Split-Path -Parent $handoff) -Force | Out-Null
Set-Content -LiteralPath $workerPid -Value ([string]$PID) -Encoding ASCII -Force
Start-Sleep -Milliseconds 180
Set-Content -LiteralPath $handoff -Value ([DateTime]::UtcNow.ToString('o')) -Encoding ASCII -Force
@{ phase = 'waiting'; percent = 12; message = 'waiting'; detail = '' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $progress -Encoding UTF8 -Force
Start-Sleep -Milliseconds 900
@{ phase = 'success'; percent = 100; message = 'complete'; detail = '' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $progress -Encoding UTF8 -Force
`
  const buildVbsLauncher = ({ scriptPath, environment = {}, sta = false }) => {
    const assignments = Object.entries(environment)
      .map(([key, value]) => '$env:' + key + "='" + String(value).replaceAll("'", "''") + "'")
      .join('; ')
    const command = (assignments ? assignments + '; ' : '') + "& '" + String(scriptPath).replaceAll("'", "''") + "'"
    const encoded = Buffer.from(command, 'utf16le').toString('base64')
    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      ...(sta ? ['-STA'] : []), '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
    ].join(' ')
    const safePowerShell = psPath.replaceAll('"', '""')
    return [
      'Option Explicit',
      'Dim shell, command',
      'Set shell = CreateObject("WScript.Shell")',
      'command = Chr(34) & "' + safePowerShell + '" & Chr(34) & " ' + args + '"',
      'shell.Run command, 0, False',
      'WScript.Sleep 500',
    ].join('\r\n') + '\r\n'
  }
  const launcherSource = [
    "import { spawn } from 'node:child_process'",
    'const [wscript, launcher] = process.argv.slice(2)',
    '// wscript.exe is a GUI-subsystem host; it creates the process boundary without',
    '// opening a console window when the Electron parent exits.',
    "const child = spawn(wscript, ['//B', '//NoLogo', launcher], { detached: true, windowsHide: true, stdio: 'ignore' })",
    'child.unref()',
    "child.once('spawn', () => setTimeout(() => process.exit(0), 80))",
    "child.once('error', () => process.exit(2))",
  ].join('\n')
  const uiSource = buildUpdateUiPowerShell({
    workerScript,
    progressFile,
    failureFile,
    handoffFile,
    version: '9.9.9',
  })
  await fsp.writeFile(workerScript, utf16Script(workerSource))
  await fsp.writeFile(launcherScript, launcherSource, 'utf8')
  await fsp.writeFile(uiScript, utf16Script(uiSource))
  await fsp.writeFile(workerLauncher, buildVbsLauncher({ scriptPath: workerScript }), 'ascii')
  await fsp.writeFile(monitorLauncher, buildVbsLauncher({
    scriptPath: uiScript,
    sta: true,
    environment: { STARBROWSER_UPDATER_MONITOR_ONLY: '1', STARBROWSER_UPDATER_WORKER_PID: '' },
  }), 'ascii')

  // Simulate Electron starting the worker and then exiting.  The launcher
  // process exits before the worker writes the marker; the detached worker
  // must still finish and publish its success state.
  const wscriptPath = path.join(process.env.SystemRoot, 'System32', 'wscript.exe')
  const launcher = spawn(process.execPath, [launcherScript, wscriptPath, workerLauncher], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const launcherResult = await waitForExit(launcher)
  assert.equal(launcherResult.code, 0, '模拟主程序应正常退出')
  assert.equal(await waitForFile(handoffFile), true, '独立 worker 必须在主程序退出后确认 handoff')

  const monitor = spawn(wscriptPath, ['//B', '//NoLogo', monitorLauncher], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      STARBROWSER_UPDATER_UI_TEST: '1',
      STARBROWSER_UPDATER_MONITOR_ONLY: '1',
      STARBROWSER_UPDATER_WORKER_PID: '',
    },
  })
  await waitForExit(monitor)
  assert.equal(await waitForMissingFile(progressFile), true, '进度窗口完成后应清理进度状态')
  console.log(JSON.stringify({ ok: true, detachedWorker: true, monitorOnly: true }, null, 2))
} finally {
  if (process.env.STARBROWSER_KEEP_UPDATE_TEST) console.error(`kept test root: ${root}`)
  else await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
}
