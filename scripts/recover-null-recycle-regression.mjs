import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [statePath, legacyStatePath] = process.argv.slice(2)
if (!statePath) throw new Error('Usage: node recover-null-recycle-regression.mjs <state.json> [legacy-state.json]')

const state = JSON.parse(await readFile(statePath, 'utf8'))
const legacy = legacyStatePath ? JSON.parse(await readFile(legacyStatePath, 'utf8')) : null
const recycleBin = Array.isArray(state.recycleBin) ? state.recycleBin : []
const accidental = recycleBin.filter((item) => {
  const session = item?.session
  return session && (session.recycleAfterDays === null || session.recycleAfterDays === undefined) && Number(session.recycleDaysRemaining) === 0
})
if (!accidental.length) throw new Error('No accidentally recycled sessions found')

const existingIds = new Set((state.sessions || []).map((session) => session.id))
for (const item of accidental) {
  const session = item.session
  session.recycleAfterDays = null
  session.recycleDaysRemaining = null
  session.recycleLastCheckedDate = null
  session.expiresAt = null
  if (!existingIds.has(session.id)) {
    state.sessions.push(session)
    existingIds.add(session.id)
  }
}
const accidentalIds = new Set(accidental.map((item) => item.session.id))
state.recycleBin = recycleBin.filter((item) => !accidentalIds.has(item?.session?.id))

if (Array.isArray(legacy?.sessions)) {
  const order = new Map(legacy.sessions.map((session, index) => [session.id, index]))
  state.sessions.sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER))
}
if (!state.sessions.some((session) => session.id === state.activeSessionId)) state.activeSessionId = state.sessions[0]?.id || ''

const directory = path.dirname(statePath)
const backupPath = path.join(directory, `state.before-recycle-recovery-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`)
await copyFile(statePath, backupPath)
const temporary = `${statePath}.${process.pid}.recovery.tmp`
await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
await rename(temporary, statePath)
console.log(JSON.stringify({ recovered: accidental.length, sessions: state.sessions.length, recycleBin: state.recycleBin.length, backupPath }, null, 2))
