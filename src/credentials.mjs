import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertSafePath, validateTool } from './state.mjs'

// Opt-in local storage is plaintext, NOT encryption. Credentials are kept only in
// credentials/<tool>.json (0600), inside credentials/ (0700), never manifests or
// backups. Atomic replacement leaves the previous credential intact on failure.
const failure = () => new Error('Unable to access a safe credential store. Check ownership, permissions, and saved credential format.')
const invalidKey = () => new Error('Provide a valid API key token without whitespace or control characters.')
const MAX_BYTES = 16384
const posix = process.platform !== 'win32'

function token(key) {
  if (typeof key !== 'string' || !key.length || key.length > 8192 || /[\s\p{Cc}\p{Cf}]/u.test(key)) throw invalidKey()
  return key
}
function locations(stateDir, tool) {
  validateTool(tool)
  if (typeof stateDir !== 'string' || !stateDir.length) throw failure()
  const root = path.resolve(stateDir)
  return { root, dir: path.join(root, 'credentials'), file: path.join(root, 'credentials', `${tool}.json`), lock: path.join(root, '.setup.lock') }
}
function owned(stat) {
  if (posix && typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw failure()
}
function privateFile(stat) {
  owned(stat)
  if (!stat.isFile() || stat.nlink !== 1 || (posix && (stat.mode & 0o7777) !== 0o600) || stat.size > MAX_BYTES) throw failure()
}
async function optionalStat(file) {
  try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function inspect(paths) {
  await assertSafePath(paths.file)
  const root = await optionalStat(paths.root)
  if (root) {
    owned(root)
    if (!root.isDirectory() || (posix && (root.mode & 0o022))) throw failure()
  }
  const dir = await optionalStat(paths.dir)
  if (dir) {
    owned(dir)
    if (!dir.isDirectory() || (posix && (dir.mode & 0o7777) !== 0o700)) throw failure()
  }
  const stat = await optionalStat(paths.file)
  if (stat) privateFile(stat)
  return stat
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino }
async function readSaved(paths, tool) {
  const stat = await inspect(paths)
  if (!stat) return null
  const handle = await fs.open(paths.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat()
    privateFile(opened)
    if (!sameFile(stat, opened)) throw failure()
    const raw = await handle.readFile('utf8')
    const after = await handle.stat()
    privateFile(after)
    if (Buffer.byteLength(raw) > MAX_BYTES || !sameFile(opened, after)) throw failure()
    const current = await inspect(paths)
    if (!current || !sameFile(opened, current)) throw failure()
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).sort().join(',') !== 'key,tool,version' || saved.version !== 1 || saved.tool !== tool) throw failure()
    return token(saved.key)
  } finally { await handle.close() }
}

export async function getCredential({ stateDir, tool, env = process.env }) {
  validateTool(tool)
  const key = env.ONEENDPOINT_API_KEY
  // An invalid nonempty environment token must not silently fall back to disk.
  if (key !== undefined && key !== '') return { key: token(key), source: 'environment' }
  try {
    const saved = await readSaved(locations(stateDir, tool), tool)
    return saved === null ? { key: undefined, source: 'missing' } : { key: saved, source: 'saved' }
  } catch { throw failure() }
}

export async function credentialExists({ stateDir, tool }) {
  return (await getCredential({ stateDir, tool, env: {} })).source === 'saved'
}

async function withLock(paths, operation) {
  await inspect(paths)
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 })
  await inspect(paths)
  await assertSafePath(paths.lock)
  let lock
  try { lock = await fs.open(paths.lock, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another setup may be active. Review the helper lock before retrying.')
    throw error
  }
  try { return await operation() } finally {
    const held = await lock.stat()
    await lock.close()
    await assertSafePath(paths.lock)
    const current = await optionalStat(paths.lock)
    if (!current || !sameFile(held, current)) throw failure()
    await fs.unlink(paths.lock)
  }
}

export async function saveCredential({ stateDir, tool, key }) {
  const paths = locations(stateDir, tool)
  token(key)
  try {
    return await withLock(paths, async () => {
      const previous = await readSaved(paths, tool)
      if (previous === key) return { changed: false }
      await fs.mkdir(paths.dir, { mode: 0o700, recursive: true })
      await inspect(paths)
      const temp = path.join(paths.dir, `.${tool}-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await fs.open(temp, 'wx', 0o600)
        await handle.chmod(0o600)
        await handle.writeFile(JSON.stringify({ version: 1, tool, key }) + '\n', 'utf8')
        await handle.sync()
        await handle.close()
        handle = null
        // The only commit is rename: all fallible preparation happens first.
        await inspect(paths)
        await assertSafePath(temp)
        privateFile(await fs.lstat(temp))
        await fs.rename(temp, paths.file)
        return { changed: true }
      } finally {
        if (handle) await handle.close()
        await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    })
  } catch (error) {
    if (error.message === 'Another setup may be active. Review the helper lock before retrying.') throw error
    throw failure()
  }
}

export async function removeCredential({ stateDir, tool, dryRun = false }) {
  const paths = locations(stateDir, tool)
  try {
    const present = await inspect(paths)
    if (dryRun || !present) return { changed: false, dryRun }
    return await withLock(paths, async () => {
      const current = await inspect(paths)
      if (!current) return { changed: false, dryRun: false }
      // Fixed validated path only; malformed JSON can be safely removed too.
      await fs.unlink(paths.file)
      return { changed: true, dryRun: false }
    })
  } catch (error) {
    if (error.message === 'Another setup may be active. Review the helper lock before retrying.') throw error
    throw failure()
  }
}
