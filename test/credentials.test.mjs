import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getCredential, saveCredential, removeCredential, credentialExists } from '../src/credentials.mjs'

const fakeKey = 'test-only-fake-token-not-a-real-api-key'
const posix = process.platform !== 'win32'
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-credentials-'))
  // macOS /var can be a symlink; resolve the isolated fixture, not a user home.
  const stateDir = await fs.realpath(root)
  t.after(async () => {
    assert.ok(stateDir.startsWith(await fs.realpath(os.tmpdir())))
    await fs.rm(stateDir, { recursive: true, force: true })
  })
  return { stateDir, tool: 'dsh', env: {} }
}
const savedFile = options => path.join(options.stateDir, 'credentials', `${options.tool}.json`)
async function writeRaw(options, raw, mode = 0o600) {
  await fs.mkdir(path.dirname(savedFile(options)), { recursive: true, mode: 0o700 })
  await fs.writeFile(savedFile(options), raw, { mode })
  await fs.chmod(savedFile(options), mode)
}

test('environment precedence avoids disk, with generic token validation', async t => {
  const options = await fixture(t)
  await writeRaw(options, '{malformed')
  assert.deepEqual(await getCredential({ ...options, env: { ONEENDPOINT_API_KEY: fakeKey } }), { key: fakeKey, source: 'environment' })
  for (const key of ['fake token', ' fake', 'fake\nkey', 'fake\0key', 'fake\tkey', 'fake\x7fkey', 'fake\u200bkey', 'fake\u00a0key', 123]) {
    await assert.rejects(getCredential({ ...options, env: { ONEENDPOINT_API_KEY: key } }), error => {
      assert.equal(error.message, 'Provide a valid API key token without whitespace or control characters.')
      return true
    })
  }
})

test('missing credentials do not create state; empty env falls back to saved', async t => {
  const options = await fixture(t)
  options.stateDir = path.join(options.stateDir, 'not-created')
  assert.deepEqual(await getCredential(options), { key: undefined, source: 'missing' })
  assert.equal(await credentialExists(options), false)
  assert.deepEqual(await removeCredential(options), { changed: false, dryRun: false })
  await assert.rejects(fs.stat(options.stateDir), { code: 'ENOENT' })
  await saveCredential({ ...options, key: fakeKey })
  assert.deepEqual(await getCredential({ ...options, env: { ONEENDPOINT_API_KEY: '' } }), { key: fakeKey, source: 'saved' })
})

test('saved keys are isolated per tool and private plaintext, not manifests or backups', async t => {
  const options = await fixture(t)
  assert.deepEqual(await saveCredential({ ...options, key: fakeKey }), { changed: true })
  assert.deepEqual(await saveCredential({ ...options, key: fakeKey }), { changed: false })
  assert.equal(await credentialExists(options), true)
  assert.deepEqual(await getCredential(options), { key: fakeKey, source: 'saved' })
  assert.deepEqual(await getCredential({ ...options, tool: 'claude' }), { key: undefined, source: 'missing' })
  await saveCredential({ ...options, tool: 'claude', key: 'another-fake-key' })
  assert.equal((await getCredential(options)).key, fakeKey)
  assert.equal((await getCredential({ ...options, tool: 'claude' })).key, 'another-fake-key')
  assert.deepEqual(await fs.readdir(options.stateDir), ['credentials'])
  assert.deepEqual((await fs.readdir(path.dirname(savedFile(options)))).sort(), ['claude.json', 'dsh.json'])
  assert.deepEqual(JSON.parse(await fs.readFile(savedFile(options), 'utf8')), { version: 1, tool: 'dsh', key: fakeKey })
  if (posix) {
    assert.equal((await fs.stat(savedFile(options))).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.dirname(savedFile(options)))).mode & 0o777, 0o700)
  }
})

test('invalid saves reject without state changes or key reflection', async t => {
  const options = await fixture(t)
  for (const key of ['', null, undefined, 'fake secret with whitespace', 'x'.repeat(8193)]) {
    await assert.rejects(saveCredential({ ...options, key }), { message: 'Provide a valid API key token without whitespace or control characters.' })
  }
  assert.deepEqual(await fs.readdir(options.stateDir), [])
  for (const tool of ['../outside', '/tmp/nope', '', 'constructor', undefined]) {
    await assert.rejects(saveCredential({ ...options, tool, key: fakeKey }))
    await assert.rejects(getCredential({ ...options, tool }))
    await assert.rejects(removeCredential({ ...options, tool }))
  }
})

test('malformed saved schemas have generic errors and never reflect content', async t => {
  const options = await fixture(t)
  for (const raw of [fakeKey, 'null', '[]', '{}', JSON.stringify({ version: 2, tool: 'dsh', key: fakeKey }), JSON.stringify({ version: 1, tool: 'claude', key: fakeKey }), JSON.stringify({ version: 1, tool: 'dsh', key: fakeKey, extra: true }), JSON.stringify({ version: 1, tool: 'dsh', key: 'invalid token' }), JSON.stringify({ version: 1, tool: 'dsh', key: 42 }), 'x'.repeat(16385)]) {
    await writeRaw(options, raw)
    await assert.rejects(getCredential(options), error => {
      assert.equal(error.message, 'Unable to access a safe credential store. Check ownership, permissions, and saved credential format.')
      assert.equal(error.message.includes(fakeKey), false)
      return true
    })
    await assert.rejects(saveCredential({ ...options, key: 'replacement-fake' }))
    assert.equal(await fs.readFile(savedFile(options), 'utf8'), raw)
  }
  // Removal does not parse or trust attacker-supplied JSON paths.
  await writeRaw(options, JSON.stringify({ files: ['/not-a-removal-target'], key: fakeKey }))
  assert.deepEqual(await removeCredential(options), { changed: true, dryRun: false })
})

test('remove is fixed-path, idempotent, and dry-run does not write', async t => {
  const options = await fixture(t)
  await saveCredential({ ...options, key: fakeKey })
  await saveCredential({ ...options, tool: 'claude', key: 'second-fake' })
  assert.deepEqual(await removeCredential({ ...options, dryRun: true }), { changed: false, dryRun: true })
  assert.equal(await credentialExists(options), true)
  assert.deepEqual(await removeCredential(options), { changed: true, dryRun: false })
  assert.deepEqual(await removeCredential(options), { changed: false, dryRun: false })
  assert.equal(await credentialExists({ ...options, tool: 'claude' }), true)
})

test('shared setup lock serializes credential writes and removal', async t => {
  const options = await fixture(t)
  await saveCredential({ ...options, key: fakeKey })
  const lock = path.join(options.stateDir, '.setup.lock')
  await fs.writeFile(lock, 'other writer', { mode: 0o600 })
  for (const operation of [() => saveCredential({ ...options, key: 'replacement-fake' }), () => removeCredential(options)]) {
    await assert.rejects(operation(), /Another setup may be active/)
    assert.equal(await fs.readFile(lock, 'utf8'), 'other writer')
    assert.equal((await getCredential(options)).key, fakeKey)
  }
  assert.deepEqual(await removeCredential({ ...options, dryRun: true }), { changed: false, dryRun: true })
})

test('atomic-write failure preserves old credential and cleans temporary files and lock', async t => {
  const options = await fixture(t)
  await saveCredential({ ...options, key: fakeKey })
  const originalRename = fs.rename
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === savedFile(options)) throw new Error(`simulated failure ${fakeKey}`)
    return originalRename(from, to)
  })
  await assert.rejects(saveCredential({ ...options, key: 'replacement-fake' }), { message: 'Unable to access a safe credential store. Check ownership, permissions, and saved credential format.' })
  assert.equal((await getCredential(options)).key, fakeKey)
  assert.deepEqual(await fs.readdir(path.dirname(savedFile(options))), ['dsh.json'])
  assert.deepEqual(await fs.readdir(options.stateDir), ['credentials'])
})

test('symlink and hardlink credential targets are rejected without touching targets', async t => {
  const options = await fixture(t)
  const outside = path.join(options.stateDir, 'outside')
  await fs.writeFile(outside, fakeKey, { mode: 0o600 })
  await fs.mkdir(path.dirname(savedFile(options)), { mode: 0o700 })
  for (const create of [() => fs.symlink(outside, savedFile(options)), () => fs.link(outside, savedFile(options))]) {
    await create()
    for (const operation of [() => getCredential(options), () => saveCredential({ ...options, key: 'replacement-fake' }), () => removeCredential(options), () => removeCredential({ ...options, dryRun: true })]) await assert.rejects(operation())
    assert.equal(await fs.readFile(outside, 'utf8'), fakeKey)
    assert.equal(savedFile(options), path.join(options.stateDir, 'credentials', 'dsh.json'))
    await fs.unlink(savedFile(options))
  }
})

test('symlink state/credential directories and lock are rejected', async t => {
  const options = await fixture(t)
  const real = path.join(options.stateDir, 'real')
  const linked = path.join(options.stateDir, 'linked')
  await fs.mkdir(real, { mode: 0o700 })
  await fs.symlink(real, linked)
  await assert.rejects(saveCredential({ ...options, stateDir: linked, key: fakeKey }))
  await assert.rejects(getCredential({ ...options, stateDir: linked }))
  await fs.symlink(real, path.join(options.stateDir, 'credentials'))
  await assert.rejects(saveCredential({ ...options, key: fakeKey }))
  await assert.rejects(getCredential(options))
  const second = await fixture(t)
  await fs.symlink(real, path.join(second.stateDir, '.setup.lock'))
  await assert.rejects(saveCredential({ ...second, key: fakeKey }))
  assert.deepEqual(await fs.readdir(real), [])
})

test('unsafe POSIX permissions and ownership are rejected, never auto-repaired', { skip: !posix }, async t => {
  const options = await fixture(t)
  await saveCredential({ ...options, key: fakeKey })
  for (const mode of [0o644, 0o666, 0o400, 0o700]) {
    await fs.chmod(savedFile(options), mode)
    await assert.rejects(getCredential(options))
    await assert.rejects(saveCredential({ ...options, key: 'replacement-fake' }))
    await assert.rejects(removeCredential(options))
    assert.equal((await fs.stat(savedFile(options))).mode & 0o777, mode)
  }
  await fs.chmod(savedFile(options), 0o600)
  await fs.chmod(path.dirname(savedFile(options)), 0o755)
  await assert.rejects(getCredential(options))
  await assert.rejects(saveCredential({ ...options, key: 'replacement-fake' }))
  await fs.chmod(path.dirname(savedFile(options)), 0o700)
  await fs.chmod(options.stateDir, 0o777)
  await assert.rejects(getCredential(options))
  await fs.chmod(options.stateDir, 0o700)
  if (typeof process.getuid === 'function') {
    const uid = process.getuid()
    t.mock.method(process, 'getuid', () => uid + 1)
    await assert.rejects(getCredential(options))
    await assert.rejects(saveCredential({ ...options, key: 'replacement-fake' }))
    await assert.rejects(removeCredential(options))
  }
})

test('directory in place of credential file is rejected', async t => {
  const options = await fixture(t)
  await fs.mkdir(savedFile(options), { recursive: true, mode: 0o700 })
  await assert.rejects(getCredential(options))
  await assert.rejects(saveCredential({ ...options, key: fakeKey }))
  await assert.rejects(removeCredential(options))
})

