import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

// Never include private file contents in errors or receipts.
export const hash = raw => raw === null ? null : createHash('sha256').update(raw).digest('hex')
export async function assertSafePath(file) {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error('Refusing a symbolic link in native configuration path.')
      if (current === absolute && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Refusing a non-regular or hardlinked native configuration file.')
      if (current !== absolute && !stat.isDirectory()) throw new Error('Invalid native configuration parent directory.')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
export async function snapshot(file) {
  await assertSafePath(file)
  try {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe native configuration file.')
      const raw = await handle.readFile('utf8')
      await assertSafePath(file)
      const now = await fs.lstat(file)
      if (now.ino !== stat.ino || now.dev !== stat.dev) throw new Error('Native configuration changed during read; retry.')
      return { raw, hash: hash(raw), mode: stat.mode & 0o777 }
    } finally { await handle.close() }
  } catch (error) { if (error.code === 'ENOENT') return { raw: null, hash: null, mode: 0o600 }; throw error }
}
export async function assertUnchanged(file, expected) {
  if ((await snapshot(file)).hash !== expected.hash) throw new Error('Native configuration changed concurrently; retry.')
}
export function parseObject(raw, label) {
  let value
  try { value = JSON.parse(raw) } catch { throw new Error(`Malformed ${label}; refusing to change native configuration.`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}; refusing to change native configuration.`)
  return value
}
export async function atomicReplace(file, raw, expected) {
  await assertUnchanged(file, expected)
  if (raw === null) {
    if (expected.raw !== null) await fs.unlink(file)
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await assertSafePath(file)
  const temporary = path.join(path.dirname(file), `.native-${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(raw, 'utf8'); await handle.sync() } finally { await handle.close() }
    await assertUnchanged(file, expected)
    await fs.rename(temporary, file)
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export async function withNativeLock(stateDir, callback) {
  await assertSafePath(path.join(stateDir, '.setup.lock'))
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const lock = path.join(stateDir, '.setup.lock')
  let handle
  try { handle = await fs.open(lock, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another setup may be active. Review the helper lock before retrying.')
    throw error
  }
  try { return await callback() } finally { await handle.close(); await fs.unlink(lock) }
}
export async function commitPair({ target, targetBefore, targetRaw, journal, journalBefore, journalRaw }) {
  await assertUnchanged(journal, journalBefore)
  const targetChanged = targetRaw !== targetBefore.raw
  if (targetChanged) await atomicReplace(target, targetRaw, targetBefore)
  try {
    if (journalRaw !== journalBefore.raw) await atomicReplace(journal, journalRaw, journalBefore)
  } catch {
    if (targetChanged) {
      try { await atomicReplace(target, targetBefore.raw, { hash: hash(targetRaw), raw: targetRaw }) }
      catch { throw new Error('Native journal commit failed and rollback was blocked; inspect native configuration before retrying.') }
    }
    throw new Error('Native journal commit failed; native configuration was rolled back.')
  }
}
export const serialize = value => JSON.stringify(value, null, 2) + '\n'
