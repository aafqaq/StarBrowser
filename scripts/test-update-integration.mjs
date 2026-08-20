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
const target = path.join(temporaryRoot, 'install')
const version = JSON.parse(await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version
const updatesRoot = path.join(target, 'data', 'updates', version)
const payload = path.join(updatesRoot, 'payload')
const captureDir = path.join(temporaryRoot, 'capture')
const token = randomBytes(16).toString('hex')

function runPowerShell(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], {
      windowsHide: true,
      cwd: os.tmpdir(),
      env: { ...process.env, STARBROWSER_CAPTURE: '1', STARBROWSER_CAPTURE_DIR: captureDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`更新脚本退出码 ${code}\n${output}`)))
  })
}

try {
  await fsp.cp(source, target, { recursive: true })
  await fsp.mkdir(payload, { recursive: true })
  await fsp.cp(source, payload, { recursive: true })
  await fsp.mkdir(path.join(target, 'data'), { recursive: true })
  await fsp.writeFile(path.join(target, 'data', 'sentinel.txt'), 'data-must-survive', 'utf8')
  await fsp.writeFile(path.join(target, 'user-export.sbsession'), 'user-file-must-survive', 'utf8')
  const oldManifest = parseProgramManifest(JSON.parse(await fsp.readFile(path.join(target, 'starbrowser-update.json'), 'utf8')), true)
  const newManifest = parseProgramManifest(JSON.parse(await fsp.readFile(path.join(payload, 'starbrowser-update.json'), 'utf8')))
  const script = buildApplyUpdatePowerShell({
    targetRoot: target, payloadRoot: payload, updatesRoot, mainPid: 999999,
    token, oldOwnedTopLevel: oldManifest.ownedTopLevel, newOwnedTopLevel: newManifest.ownedTopLevel,
  })
  const scriptPath = path.join(updatesRoot, 'apply-update.ps1')
  await fsp.writeFile(scriptPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]))
  await runPowerShell(scriptPath)
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(captureDir, 'capture-result.json')); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const installed = parseProgramManifest(JSON.parse(await fsp.readFile(path.join(target, 'starbrowser-update.json'), 'utf8')))
  const sentinel = await fsp.readFile(path.join(target, 'data', 'sentinel.txt'), 'utf8')
  const userExport = await fsp.readFile(path.join(target, 'user-export.sbsession'), 'utf8')
  if (installed.version !== version || sentinel !== 'data-must-survive' || userExport !== 'user-file-must-survive') throw new Error('更新后校验失败')
  if (fs.existsSync(updatesRoot)) throw new Error('成功更新后仍残留更新临时目录')
  console.log(JSON.stringify({ ok: true, version, dataPreserved: true, unknownUserFilePreserved: true, temporaryArtifactsRemoved: true }, null, 2))
} finally {
  await new Promise((resolve) => setTimeout(resolve, 800))
  await fsp.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
