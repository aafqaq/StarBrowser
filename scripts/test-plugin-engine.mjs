import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginService } from '../main/plugin-service.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'starbrowser-plugin-test-'))
const manifestPath = path.join(temporary, 'example-plugin.json')
const manifestBuffer = Buffer.from(JSON.stringify({
  schemaVersion: 1, id: 'example-status', version: '1.0.0', name: 'Example status',
  permissions: { hosts: ['https://example.com'], capabilities: ['session.fetch'] },
  settingsSchema: [
    { key: 'updateMode', type: 'select', default: 'startup', options: [{ label: 'Startup', value: 'startup' }, { label: 'Interval', value: 'interval' }] },
    { key: 'intervalHours', type: 'number', default: 6, minimum: 1, maximum: 720 },
  ],
  hooks: {
    sessionMatch: { tabHosts: ['example.com'] },
    refresh: { steps: [{ id: 'status', request: { method: 'GET', url: 'https://example.com/status' } }],
      outputs: [{ key: 'count', sources: ['steps.status.body.count'], transform: 'nonnegative-integer' }] },
  },
}))
await fsp.writeFile(manifestPath, manifestBuffer)
const catalogBuffer = Buffer.from(JSON.stringify({ schemaVersion: 1, plugins: [{
  id: 'example-status', version: '1.0.0', name: 'Example status',
  manifestUrl: 'https://raw.githubusercontent.com/aafqaq/StarBrowser/main/plugins/example-status/plugin.json',
  sha256: createHash('sha256').update(manifestBuffer).digest('hex'),
}] }))
const sessions = [{ id: 'example-session', name: 'Example', tabs: [{ url: 'https://example.com/' }] }]

function response(body, status = 200) {
  return new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const service = new PluginService({
  dataRoot: temporary,
  projectRoot: root,
  appVersion: '1.7.1',
  fetch: async (url) => String(url).endsWith('/plugins/catalog.json') ? response(catalogBuffer) : response(manifestBuffer),
  getSessions: () => sessions,
  getSession: () => ({
    fetch: async () => response({ count: 2 }),
  }),
  notify: () => {},
})

try {
  await service.initialize()
  assert.equal(service.publicState().installed.length, 0, 'fresh install must not enable plugins')
  assert.equal(service.publicState().catalog.length, 0, 'repository catalog is empty')
  await service.refreshCatalog()
  assert.equal(service.publicState().catalog.length, 1, 'synthetic catalog should be available')

  await service.install('example-status')
  await service.run('example-status', { reason: 'test' })
  let publicState = service.publicState()
  assert.equal(publicState.installed.length, 1)
  assert.equal(publicState.results['example-status']['example-session'].status, 'ok')
  assert.equal(publicState.results['example-status']['example-session'].fields.count, 2)

  await service.updateConfig('example-status', { updateMode: 'interval', intervalHours: 12 })
  await service.uninstall('example-status', false)
  let engine = JSON.parse(await fsp.readFile(path.join(temporary, 'plugins', 'engine.json'), 'utf8'))
  assert.deepEqual(engine.configs['example-status'], { updateMode: 'interval', intervalHours: 12 }, 'uninstall should preserve config by default')

  await service.importFile(manifestPath)
  await service.run('example-status', { reason: 'reinstall-test' })
  assert.equal(service.publicState().installed[0].config.intervalHours, 12, 'reinstall should reuse retained config')
  await service.uninstall('example-status', true)
  engine = JSON.parse(await fsp.readFile(path.join(temporary, 'plugins', 'engine.json'), 'utf8'))
  assert.equal(engine.configs['example-status'], undefined, 'optional config deletion should remove only plugin config')
  assert.equal(engine.schemaVersion, 1)

  // An existing plugin remains usable even when it is absent from the catalog.
  const legacyManifest = JSON.parse(manifestBuffer)
  legacyManifest.id = 'chatgpt-usage'
  await fsp.writeFile(manifestPath, JSON.stringify(legacyManifest))
  await service.importFile(manifestPath)
  await service.run('chatgpt-usage', { reason: 'manual-import' })
  assert.equal(service.publicState().results['chatgpt-usage']['example-session'].fields.count, 2)
  service.dispose()
  await service.initialize()
  await service.run('chatgpt-usage', { reason: 'restart' })
  assert.equal(service.publicState().results['chatgpt-usage']['example-session'].status, 'ok')
  console.log('Plugin engine tests passed')
} finally {
  service.dispose()
  await fsp.rm(temporary, { recursive: true, force: true })
}
