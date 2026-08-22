import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildApplyUpdatePowerShell, parseProgramManifest } from '../main/update-service.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(projectRoot, 'dist')
if (!fs.existsSync(path.join(source, 'StarBrowser.exe'))) throw new Error('请先运行 npm run dist')
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'starbrowser-update-integration-'))
const version = JSON.parse(await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version

function runPowerShell(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], {
      windowsHide: true,
      cwd: os.tmpdir(),
      env: { ...process.env, STARBROWSER_CAPTURE: '1', STARBROWSER_UPDATE_INTEGRATION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`更新脚本退出码 ${code}\n${output}`)))
  })
}

async function runScenario(name, simulateCleanupLock, packageKind = 'full') {
  const scenarioRoot = path.join(temporaryRoot, name)
  const target = path.join(scenarioRoot, 'install')
  const updatesRoot = path.join(target, 'data', 'updates', version)
  const payload = path.join(updatesRoot, 'payload')
  const token = randomBytes(16).toString('hex')

  await fsp.cp(source, target, { recursive: true })
  await fsp.mkdir(payload, { recursive: true })
  if (packageKind === 'app') {
    await fsp.mkdir(path.join(payload, 'resources'), { recursive: true })
    await fsp.copyFile(path.join(source, 'resources', 'app.asar'), path.join(payload, 'resources', 'app.asar'))
    await fsp.copyFile(path.join(source, 'starbrowser-update.json'), path.join(payload, 'starbrowser-update.json'))
    // Ensure this is a real ASAR replacement, not a no-op copy of identical
    // files. The staged package remains valid while the simulated installed
    // app contains a different old payload.
    await fsp.writeFile(path.join(target, 'resources', 'app.asar'), 'simulated-old-app-asar', 'utf8')
  } else {
    await fsp.cp(source, payload, { recursive: true })
  }
  await fsp.mkdir(path.join(target, 'data'), { recursive: true })
  await fsp.writeFile(path.join(target, 'data', 'sentinel.txt'), 'data-must-survive', 'utf8')
  await fsp.writeFile(path.join(target, 'user-export.sbsession'), 'user-file-must-survive', 'utf8')
  const oldManifest = parseProgramManifest(JSON.parse(await fsp.readFile(path.join(target, 'starbrowser-update.json'), 'utf8')), true)
  const newManifest = parseProgramManifest(JSON.parse(await fsp.readFile(path.join(payload, 'starbrowser-update.json'), 'utf8')))
  let script = buildApplyUpdatePowerShell({
    targetRoot: target, payloadRoot: payload, updatesRoot, mainPid: 999999,
    token, oldOwnedTopLevel: oldManifest.ownedTopLevel, newOwnedTopLevel: newManifest.ownedTopLevel, packageKind,
  })
  if (simulateCleanupLock) {
    const cleanupCommand = "Invoke-WithRetry '清理更新临时目录' { Remove-Item -LiteralPath $updates -Recurse -Force -ErrorAction Stop }"
    if (!script.includes(cleanupCommand)) throw new Error('无法注入更新临时目录锁定测试')
    script = script.replace(cleanupCommand, "throw 'simulated EBUSY app.asar cleanup lock'")
  }
  const scriptPath = path.join(updatesRoot, 'apply-update.ps1')
  await fsp.writeFile(scriptPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]))
  await runPowerShell(scriptPath)
  const installed = parseProgramManifest(JSON.parse(await fsp.readFile(path.join(target, 'starbrowser-update.json'), 'utf8')))
  const sentinel = await fsp.readFile(path.join(target, 'data', 'sentinel.txt'), 'utf8')
  const userExport = await fsp.readFile(path.join(target, 'user-export.sbsession'), 'utf8')
  if (installed.version !== version || sentinel !== 'data-must-survive' || userExport !== 'user-file-must-survive') throw new Error(`${name} 更新后校验失败`)
  if (packageKind === 'app') {
    const [expectedAsar, installedAsar] = await Promise.all([
      fsp.readFile(path.join(source, 'resources', 'app.asar')),
      fsp.readFile(path.join(target, 'resources', 'app.asar')),
    ])
    if (!expectedAsar.equals(installedAsar)) throw new Error(`${name} 未正确替换 app.asar`)
  }
  if (fs.existsSync(path.join(target, 'data', 'update-error.log'))) throw new Error(`${name} 健康新版被错误标记为更新失败`)
  const cleanupLog = path.join(target, 'data', 'update-cleanup-pending.log')
  if (simulateCleanupLock) {
    if (!fs.existsSync(updatesRoot) || !fs.existsSync(cleanupLog)) throw new Error('锁定清理失败未正确留待下次启动处理')
  } else if (fs.existsSync(updatesRoot) || fs.existsSync(cleanupLog)) {
    throw new Error('成功更新后仍残留更新临时目录或待清理标记')
  }
  return {
    name,
    packageKind,
    installedVersion: installed.version,
    dataPreserved: true,
    cleanupDeferredWithoutRollback: simulateCleanupLock,
  }
}

try {
  const normal = await runScenario('normal-cleanup', false)
  const locked = await runScenario('locked-asar-cleanup', true)
  const lite = await runScenario('lightweight-app-update', false, 'app')
  const liteLocked = await runScenario('lightweight-locked-cleanup', true, 'app')
  console.log(JSON.stringify({ ok: true, version, scenarios: [normal, locked, lite, liteLocked] }, null, 2))
} finally {
  await new Promise((resolve) => setTimeout(resolve, 800))
  await fsp.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
