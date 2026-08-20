import assert from 'node:assert/strict'
import path from 'node:path'
import { buildApplyUpdatePowerShell, compareVersions, parseProgramManifest, parseReleaseCandidate } from '../main/update-service.mjs'

assert.equal(compareVersions('1.7.0', '1.6.2'), 1)
assert.equal(compareVersions('v1.7.0', '1.7.0'), 0)
assert.equal(compareVersions('1.6.2', '1.7.0'), -1)
const program = parseProgramManifest({ version: '1.7.0', ownedTopLevel: ['StarBrowser.exe', 'resources', 'locales', 'starbrowser-update.json'] })
assert.equal(program.ownedTopLevel.includes('data'), false)
const candidate = parseReleaseCandidate({
  tag_name: 'v1.7.0', draft: false, prerelease: false, name: 'v1.7.0', body: '更新说明', html_url: 'https://github.com/aafqaq/StarBrowser/releases/tag/v1.7.0',
  assets: [{ name: 'StarBrowser-Windows-x64-v1.7.0.zip', browser_download_url: 'https://example.invalid/update.zip', size: 10, digest: `sha256:${'a'.repeat(64)}` }],
}, { version: '1.7.0', asset: { name: 'StarBrowser-Windows-x64-v1.7.0.zip' } }, '1.6.2', '')
assert.equal(candidate.version, '1.7.0')
assert.equal(parseReleaseCandidate({ ...candidate, tag_name: 'v1.7.0' }, { version: '1.7.0' }, '1.6.2', '1.7.0'), null)
const target = path.resolve('C:/StarBrowser')
const updates = path.join(target, 'data', 'updates', '1.7.0')
const script = buildApplyUpdatePowerShell({
  targetRoot: target, payloadRoot: path.join(updates, 'payload'), updatesRoot: updates,
  mainPid: 123, token: 'a'.repeat(32), oldOwnedTopLevel: program.ownedTopLevel, newOwnedTopLevel: program.ownedTopLevel,
})
assert.ok(script.length > 1000 && script.includes('Assert-SafeRoot'))
assert.throws(() => buildApplyUpdatePowerShell({ targetRoot: target, payloadRoot: 'C:/outside', updatesRoot: updates, mainPid: 1, token: 'x', oldOwnedTopLevel: [], newOwnedTopLevel: [] }))
console.log('自动更新核心测试通过。')
