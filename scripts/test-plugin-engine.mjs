import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginService } from '../main/plugin-service.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'starbrowser-plugin-test-'))
const manifestPath = path.join(root, 'plugins', 'chatgpt-usage', 'plugin.json')
const catalogPath = path.join(root, 'plugins', 'catalog.json')
const manifestBuffer = await fsp.readFile(manifestPath)
const catalogBuffer = await fsp.readFile(catalogPath)
const sessions = [{ id: 'chatgpt-session', name: 'ChatGPT Plus', tabs: [{ url: 'https://chatgpt.com/' }] }]

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
    fetch: async (url) => String(url).includes('/api/auth/session')
      ? response({ accessToken: 'test-token', user: { plan_type: 'plus' } })
      : response({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 37, reset_after_seconds: 7200 } } }),
  }),
  notify: () => {},
})

try {
  await service.initialize()
  assert.equal(service.publicState().installed.length, 0, 'fresh install must not enable plugins')
  assert.equal(service.publicState().catalog.length, 1, 'repository catalog should be available')

  await service.install('chatgpt-usage')
  await service.run('chatgpt-usage', { reason: 'test' })
  let publicState = service.publicState()
  assert.equal(publicState.installed.length, 1)
  assert.equal(publicState.results['chatgpt-usage']['chatgpt-session'].status, 'ok')
  assert.equal(publicState.results['chatgpt-usage']['chatgpt-session'].fields.remainingPercent, 63)
  assert.match(String(publicState.results['chatgpt-usage']['chatgpt-session'].fields.resetAt), /^\d{4}-\d{2}-\d{2}T/)

  await service.updateConfig('chatgpt-usage', { updateMode: 'interval', intervalHours: 12 })
  await service.uninstall('chatgpt-usage', false)
  let engine = JSON.parse(await fsp.readFile(path.join(temporary, 'plugins', 'engine.json'), 'utf8'))
  assert.deepEqual(engine.configs['chatgpt-usage'], { updateMode: 'interval', intervalHours: 12 }, 'uninstall should preserve config by default')

  await service.importFile(manifestPath)
  assert.equal(service.publicState().installed[0].config.intervalHours, 12, 'reinstall should reuse retained config')
  await service.uninstall('chatgpt-usage', true)
  engine = JSON.parse(await fsp.readFile(path.join(temporary, 'plugins', 'engine.json'), 'utf8'))
  assert.equal(engine.configs['chatgpt-usage'], undefined, 'optional config deletion should remove only plugin config')
  assert.equal(engine.schemaVersion, 1)
  console.log('Plugin engine tests passed')
} finally {
  service.dispose()
  await fsp.rm(temporary, { recursive: true, force: true })
}
