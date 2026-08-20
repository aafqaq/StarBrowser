import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildApplyUpdatePowerShell, buildUpdateUiPowerShell, compareVersions, parseProgramManifest, parseReleaseCandidate } from '../main/update-service.mjs'

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
assert.equal(parseReleaseCandidate({ ...candidate, tag_name: 'v1.7.1' }, { version: '1.7.1' }, '1.6.2', '1.7.1'), null)
const target = path.resolve('C:/StarBrowser')
const updates = path.join(target, 'data', 'updates', '1.7.1')
const script = buildApplyUpdatePowerShell({
  targetRoot: target, payloadRoot: path.join(updates, 'payload'), updatesRoot: updates,
  mainPid: 123, token: 'a'.repeat(32), oldOwnedTopLevel: program.ownedTopLevel, newOwnedTopLevel: program.ownedTopLevel,
})
assert.ok(script.length > 1000 && script.includes('Assert-SafeRoot'))
assert.ok(script.includes('handoff-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ready'), 'updater must acknowledge handoff before the app exits')
assert.ok(script.includes('A transient antivirus/ASAR lock must'), 'cleanup failure after a healthy launch must not trigger rollback')
assert.ok(script.includes('$programChanged = $false'), 'rollback must only run after program mutation begins')
assert.ok(script.includes("Write-UpdateProgress 'success' 100"), 'worker must report completion to the visible updater')
const uiScript = buildUpdateUiPowerShell({
  workerScript: path.join(updates, 'apply-update-worker.ps1'),
  progressFile: path.join(target, 'data', 'update-progress.json'),
  failureFile: path.join(target, 'data', 'update-error.log'),
  version: '1.7.1',
})
assert.ok(uiScript.includes('正在更新 StarBrowser') && uiScript.includes('DispatcherTimer'), 'visible updater must show live progress')
const parsePowerShell = (source) => spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  "$encoded = [Console]::In.ReadToEnd(); $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)); $tokens = $null; $errors = $null; [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
], { input: Buffer.from(source, 'utf8').toString('base64'), encoding: 'utf8', windowsHide: true })
const workerParse = parsePowerShell(script)
const uiParse = parsePowerShell(uiScript)
assert.equal(workerParse.status, 0, `update worker PowerShell must parse: ${workerParse.stderr}`)
assert.equal(uiParse.status, 0, `visible updater PowerShell must parse: ${uiParse.stderr}`)
assert.throws(() => buildApplyUpdatePowerShell({ targetRoot: target, payloadRoot: 'C:/outside', updatesRoot: updates, mainPid: 1, token: 'x', oldOwnedTopLevel: [], newOwnedTopLevel: [] }))
console.log('自动更新核心测试通过。')
