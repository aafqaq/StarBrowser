import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildApplyUpdatePowerShell, buildUpdateUiPowerShell, compareVersions, createRuntimeId, parseProgramManifest, parseReleaseCandidate } from '../main/update-service.mjs'

assert.equal(compareVersions('1.7.1', '1.6.2'), 1)
assert.equal(compareVersions('v1.7.1', '1.7.1'), 0)
assert.equal(compareVersions('1.6.2', '1.7.1'), -1)
const program = parseProgramManifest({ version: '1.7.1', ownedTopLevel: ['StarBrowser.exe', 'resources', 'locales', 'starbrowser-update.json'] })
assert.equal(program.ownedTopLevel.includes('data'), false)
const candidate = parseReleaseCandidate({
  tag_name: 'v1.7.1', draft: false, prerelease: false, name: 'v1.7.1', body: '更新说明', html_url: 'https://github.com/aafqaq/StarBrowser/releases/tag/v1.7.1',
  assets: [{ name: 'StarBrowser-Windows-x64-v1.7.1.zip', browser_download_url: 'https://example.invalid/update.zip', size: 10, digest: `sha256:${'a'.repeat(64)}` }],
}, { version: '1.7.1', asset: { name: 'StarBrowser-Windows-x64-v1.7.1.zip' } }, '1.6.2', '')
assert.equal(candidate.version, '1.7.1')
assert.equal(candidate.asset.kind, 'full')
const runtimeId = createRuntimeId('43.4.1', 'win32', 'x64')
const dualRelease = {
  tag_name: 'v1.7.2', draft: false, prerelease: false,
  assets: [
    { name: 'StarBrowser-App-v1.7.2.zip', browser_download_url: 'https://example.invalid/app.zip', size: 2, digest: `sha256:${'b'.repeat(64)}` },
    { name: 'StarBrowser-Windows-x64-v1.7.2.zip', browser_download_url: 'https://example.invalid/full.zip', size: 100, digest: `sha256:${'c'.repeat(64)}` },
  ],
}
const dualManifest = {
  version: '1.7.2',
  asset: { name: 'StarBrowser-Windows-x64-v1.7.2.zip', sha256: 'c'.repeat(64) },
  assets: {
    app: { name: 'StarBrowser-App-v1.7.2.zip', sha256: 'b'.repeat(64), runtimeId },
    full: { name: 'StarBrowser-Windows-x64-v1.7.2.zip', sha256: 'c'.repeat(64) },
  },
}
assert.equal(parseReleaseCandidate(dualRelease, dualManifest, '1.7.1', '', runtimeId).asset.kind, 'app', 'matching runtime should select the lightweight package')
assert.equal(parseReleaseCandidate(dualRelease, dualManifest, '1.7.1', '', createRuntimeId('44.0.0')).asset.kind, 'full', 'a different Chromium runtime must select the complete package')
assert.equal(parseReleaseCandidate({ ...candidate, tag_name: 'v1.7.1' }, { version: '1.7.1' }, '1.6.2', '1.7.1'), null)
const target = path.resolve('C:/StarBrowser')
const updates = path.join(target, 'data', 'updates', '1.7.1')
const script = buildApplyUpdatePowerShell({
  targetRoot: target, payloadRoot: path.join(updates, 'payload'), updatesRoot: updates,
  mainPid: 123, token: 'a'.repeat(32), oldOwnedTopLevel: program.ownedTopLevel, newOwnedTopLevel: program.ownedTopLevel,
})
assert.ok(script.length > 1000 && script.includes('Assert-SafeRoot'))
assert.ok(script.includes('handoff-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ready'), 'updater must acknowledge handoff before the app exits')
assert.ok(script.includes("$workerPidFile = Join-Path $updates 'worker.pid'") && script.includes('Set-Content -LiteralPath $workerPidFile'), 'updater must publish a worker liveness marker')
assert.ok(script.includes('PathType Container') && script.includes('Get-CanonicalPath'), 'updater must validate canonical staging directories')
assert.ok(script.includes('exit 1'), 'handled worker failures must not be reported as exit code 0')
assert.ok(script.includes('A transient antivirus/ASAR lock must'), 'cleanup failure after a healthy launch must not trigger rollback')
assert.ok(script.includes('$programChanged = $false'), 'rollback must only run after program mutation begins')
assert.ok(script.includes("Write-UpdateProgress 'success' 100"), 'worker must report completion to the visible updater')
const appScript = buildApplyUpdatePowerShell({
  targetRoot: target, payloadRoot: path.join(updates, 'payload'), updatesRoot: updates,
  mainPid: 123, token: 'b'.repeat(32), oldOwnedTopLevel: program.ownedTopLevel, newOwnedTopLevel: program.ownedTopLevel, packageKind: 'app',
})
assert.ok(appScript.includes("$packageKind = 'app'") && appScript.includes("'resources\\app.asar'"), 'lightweight updates must only replace the ASAR and program manifest')
assert.ok(appScript.includes('恢复 $relative'), 'lightweight update failure must restore each replaced file')
const validationCall = script.lastIndexOf('\n  Assert-SafeRoot')
const handoffCall = script.lastIndexOf('\n  Write-UpdateHandoff')
assert.ok(validationCall >= 0 && handoffCall > validationCall, 'invalid staging paths must not close the running app')
const uiScript = buildUpdateUiPowerShell({
  workerScript: path.join(updates, 'apply-update-worker.ps1'),
  progressFile: path.join(target, 'data', 'update-progress.json'),
  failureFile: path.join(target, 'data', 'update-error.log'),
  handoffFile: path.join(updates, 'handoff-test.ready'),
  version: '1.7.1',
})
assert.ok(uiScript.includes('正在更新 StarBrowser') && uiScript.includes('DispatcherTimer') && uiScript.includes('handoff-test.ready'), 'visible updater must show live progress and acknowledge handoff early')
const parsePowerShell = (source) => spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  "$encoded = [Console]::In.ReadToEnd(); $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)); $tokens = $null; $errors = $null; [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
], { input: Buffer.from(source, 'utf8').toString('base64'), encoding: 'utf8', windowsHide: true })
const workerParse = parsePowerShell(script)
const appWorkerParse = parsePowerShell(appScript)
const uiParse = parsePowerShell(uiScript)
assert.equal(workerParse.status, 0, `update worker PowerShell must parse: ${workerParse.stderr}`)
assert.equal(appWorkerParse.status, 0, `lightweight update worker PowerShell must parse: ${appWorkerParse.stderr}`)
assert.equal(uiParse.status, 0, `visible updater PowerShell must parse: ${uiParse.stderr}`)
assert.throws(() => buildApplyUpdatePowerShell({ targetRoot: target, payloadRoot: 'C:/outside', updatesRoot: updates, mainPid: 1, token: 'x', oldOwnedTopLevel: [], newOwnedTopLevel: [] }))
console.log('自动更新核心测试通过。')
