import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export let updateFs = fs
try {
  // Electron makes *.asar look like a mounted directory. Update staging must
  // always use the unpatched filesystem or recursive cleanup can fail with
  // EBUSY / invalid-package errors while no process actually owns the file.
  updateFs = require('original-fs')
} catch {
  // Plain Node.js and unit tests do not expose Electron's original-fs built-in.
}

export const updateFsp = updateFs.promises

export async function removeUpdateTree(target) {
  await updateFsp.rm(target, { recursive: true, force: true, maxRetries: 16, retryDelay: 250 })
}
