import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { applyClaude, removeClaude, inspectClaude, resolveClaudePath, CONFLICTING_ENV } from '../src/native/claude.mjs'
import { atomicReplace, commitPair, snapshot, serialize } from '../src/native/store.mjs'

async function fixture(t, settings) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'native-claude-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home-用户')
  const stateDir = path.join(root, 'helper')
  const options = { stateDir, home, platform: process.platform, env: {}, model: 'public/model', key: 'secret-test-key' }
  const target = resolveClaudePath(options)
  const journal = path.join(stateDir, 'native', 'claude.json')
  if (settings !== undefined) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, typeof settings === 'string' ? settings : serialize(settings))
  }
  return { root, options, target, journal, read: async () => JSON.parse(await fs.readFile(target, 'utf8')) }
}
const absent = async file => assert.rejects(fs.stat(file), { code: 'ENOENT' })

test('pure native resolution across macOS/Linux/Windows and Unicode overrides', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(resolveClaudePath({ env: {}, home: '/home/用户', platform }), '/home/用户/.claude/settings.json')
    assert.equal(resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: '~/custom 目录' }, home: '/home/用户', platform }), '/home/用户/custom 目录/settings.json')
    assert.equal(resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: '/custom/配置' }, home: '/home/x', platform }), '/custom/配置/settings.json')
    assert.throws(() => resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: 'relative' }, home: '/home/x', platform }), /absolute/)
  }
  assert.equal(resolveClaudePath({ env: {}, home: 'C:\\Users\\用户', platform: 'win32' }), 'C:\\Users\\用户\\.claude\\settings.json')
  assert.equal(resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: '~/配置' }, home: 'C:\\Users\\用户', platform: 'win32' }), 'C:\\Users\\用户\\配置\\settings.json')
  assert.equal(resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: 'D:\\Claude Config' }, home: 'C:\\Users\\x', platform: 'win32' }), 'D:\\Claude Config\\settings.json')
  assert.equal(resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: '\\\\server\\share\\配置' }, home: 'C:\\Users\\x', platform: 'win32' }), '\\\\server\\share\\配置\\settings.json')
  for (const dir of ['C:relative', '\\relative', 'relative']) assert.throws(() => resolveClaudePath({ env: { CLAUDE_CONFIG_DIR: dir }, home: 'C:\\Users\\x', platform: 'win32' }), /absolute/)
})

test('safe merge, private journal, role selection, and full per-field restoration', async t => {
  const original = { model: 'old', apiKeyHelper: 'custom-auth-command', hooks: { keep: true }, permissions: { allow: ['Read'] }, env: { KEEP: 'unchanged', ANTHROPIC_AUTH_TOKEN: 'old-sensitive-token', ...Object.fromEntries(CONFLICTING_ENV.map(key => [key, 'old-value'])) } }
  const f = await fixture(t, original)
  const result = await applyClaude({ ...f.options, roles: { sonnet: 'new-sonnet', opus: 'new-opus', haiku: 'new-haiku' } })
  assert.equal(result.configured, true)
  assert.equal(result.changed, true)
  assert.equal(JSON.stringify(result).includes('secret-test-key'), false)
  const settings = await f.read()
  assert.equal(settings.model, 'new-sonnet')
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'secret-test-key')
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'new-opus')
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'new-sonnet')
  assert.equal(settings.env.KEEP, 'unchanged')
  for (const key of CONFLICTING_ENV) assert.equal(Object.hasOwn(settings.env, key), false)
  assert.equal(Object.hasOwn(settings, 'apiKeyHelper'), false)
  assert.deepEqual(settings.hooks, original.hooks)
  assert.equal((await fs.stat(f.journal)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600)
  const inspect = await inspectClaude(f.options)
  assert.equal(inspect.drift, false)
  assert.equal(JSON.stringify(inspect).includes('sensitive'), false)
  await removeClaude(f.options)
  assert.deepEqual(await f.read(), original)
  await absent(f.journal)
})

test('idempotence and changed keys/models retain the original baseline', async t => {
  const original = { env: { ANTHROPIC_MODEL: 'baseline', OTHER: 'keep' }, model: 'original' }
  const f = await fixture(t, original)
  await applyClaude(f.options)
  const priorRaw = await fs.readFile(f.journal, 'utf8')
  assert.equal((await applyClaude(f.options)).changed, false)
  assert.equal(await fs.readFile(f.journal, 'utf8'), priorRaw)
  await applyClaude({ ...f.options, model: 'model-two', key: 'rotated-key', roles: { fable: 'fable-role' } })
  assert.equal((await f.read()).env.ANTHROPIC_AUTH_TOKEN, 'rotated-key')
  assert.equal((await f.read()).env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable-role')
  await removeClaude(f.options)
  assert.deepEqual(await f.read(), original)
})

test('unrelated runtime edits survive reconfigure and removal', async t => {
  const f = await fixture(t)
  await applyClaude(f.options)
  const settings = await f.read()
  settings.permissions = { deny: ['Write'] }
  settings.env.NEW_RUNTIME = 'preserved'
  settings.hasCompletedOnboarding = true
  await fs.writeFile(f.target, serialize(settings))
  await applyClaude({ ...f.options, model: 'new-model' })
  await removeClaude(f.options)
  assert.deepEqual(await f.read(), { permissions: { deny: ['Write'] }, env: { NEW_RUNTIME: 'preserved' }, hasCompletedOnboarding: true })
})

test('new empty settings are removed but runtime directories and other files remain', async t => {
  const f = await fixture(t)
  await applyClaude(f.options)
  const marker = path.join(path.dirname(f.target), 'runtime-marker')
  await fs.writeFile(marker, 'runtime')
  await removeClaude(f.options)
  await absent(f.target)
  assert.equal(await fs.readFile(marker, 'utf8'), 'runtime')
  assert.equal((await inspectClaude(f.options)).configured, false)
})

test('existing empty settings and empty env are restored rather than deleted', async t => {
  for (const original of [{}, { env: {} }]) {
    const f = await fixture(t, original)
    await applyClaude(f.options)
    await removeClaude(f.options)
    assert.deepEqual(await f.read(), original)
  }
})

test('owned-field drift refuses apply/removal and force only restores owned fields', async t => {
  const f = await fixture(t, { model: 'baseline', env: { ANTHROPIC_API_KEY: 'prior-key' } })
  await applyClaude(f.options)
  const settings = await f.read()
  settings.env.ANTHROPIC_AUTH_TOKEN = 'external-edit'
  settings.env.UNRELATED = 'leave-alone'
  settings.hooks = ['leave-alone']
  await fs.writeFile(f.target, serialize(settings))
  assert.equal((await inspectClaude(f.options)).drift, true)
  await assert.rejects(applyClaude(f.options), /modified/)
  await assert.rejects(removeClaude(f.options), /force/)
  await removeClaude({ ...f.options, force: true })
  assert.deepEqual(await f.read(), { model: 'baseline', env: { ANTHROPIC_API_KEY: 'prior-key', UNRELATED: 'leave-alone' }, hooks: ['leave-alone'] })
})

test('missing journal removal never deletes or parses unmanaged settings', async t => {
  const f = await fixture(t, 'not-json-with-user-secret')
  assert.equal((await removeClaude({ ...f.options, force: true })).changed, false)
  assert.equal(await fs.readFile(f.target, 'utf8'), 'not-json-with-user-secret')
  assert.equal((await inspectClaude(f.options)).configured, false)
  await absent(f.options.stateDir)
})

test('malformed settings, env, and journals fail closed without leaking secrets', async t => {
  for (const original of ['{ secret-test-key', '[]', '{"env": null}', '{"env": "secret-test-key"}']) {
    const f = await fixture(t, original)
    await assert.rejects(applyClaude(f.options), error => !error.message.includes('secret-test-key'))
    assert.equal(await fs.readFile(f.target, 'utf8'), original)
    await absent(f.journal)
  }
  const f = await fixture(t)
  await applyClaude(f.options)
  const native = await fs.readFile(f.target, 'utf8')
  for (const raw of ['{bad', '{}', '{"version":1,"fields":{}}']) {
    await fs.writeFile(f.journal, raw)
    await assert.rejects(removeClaude({ ...f.options, force: true }), /journal/)
    assert.equal(await fs.readFile(f.target, 'utf8'), native)
  }
})

test('target override changes are refused, even for force removal', async t => {
  const f = await fixture(t)
  await applyClaude(f.options)
  const other = path.join(f.root, 'other')
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'settings.json'), '{"user": true}')
  const changed = { ...f.options, env: { CLAUDE_CONFIG_DIR: other } }
  for (const action of [applyClaude, inspectClaude, removeClaude]) await assert.rejects(action({ ...changed, force: true }), /target path mismatch/)
  assert.equal(await fs.readFile(path.join(other, 'settings.json'), 'utf8'), '{"user": true}')
  assert.equal((await inspectClaude(f.options)).configured, true)
})

test('explicit custom config directory writes only its resolved target', async t => {
  const f = await fixture(t)
  const options = { ...f.options, env: { CLAUDE_CONFIG_DIR: '~/custom-配置' } }
  await applyClaude(options)
  await absent(f.target)
  assert.equal(JSON.parse(await fs.readFile(resolveClaudePath(options), 'utf8')).model, 'public/model')
  await removeClaude(options)
  await absent(resolveClaudePath(options))
})

test('dry run writes nothing and predicts changes; removal dry run retains all files', async t => {
  const f = await fixture(t)
  assert.equal((await applyClaude({ ...f.options, dryRun: true })).wouldChange, true)
  await absent(f.options.stateDir)
  await absent(f.target)
  await applyClaude(f.options)
  const original = await fs.readFile(f.target, 'utf8')
  const result = await removeClaude({ ...f.options, dryRun: true })
  assert.equal(result.changed, false)
  assert.equal(result.configured, true)
  assert.equal(await fs.readFile(f.target, 'utf8'), original)
})

test('cooperating .setup.lock excludes native writers', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.options.stateDir)
  const lock = path.join(f.options.stateDir, '.setup.lock')
  await fs.writeFile(lock, 'held')
  await assert.rejects(applyClaude(f.options), /Another setup/)
  await absent(f.target)
  await fs.unlink(lock)
  await applyClaude(f.options)
  await fs.writeFile(lock, 'held')
  await assert.rejects(removeClaude(f.options), /Another setup/)
  assert.equal((await inspectClaude(f.options)).configured, true)
})

test('symbolic links, linked ancestors, and hardlinks are rejected without writes', async t => {
  for (const kind of ['symlink', 'hardlink', 'ancestor']) {
    const f = await fixture(t)
    const external = path.join(f.root, 'external')
    await fs.mkdir(external)
    const externalFile = path.join(external, 'settings.json')
    await fs.writeFile(externalFile, '{}')
    await fs.mkdir(f.options.home, { recursive: true })
    if (kind === 'ancestor') await fs.symlink(external, path.dirname(f.target), 'dir')
    else {
      await fs.mkdir(path.dirname(f.target))
      if (kind === 'symlink') await fs.symlink(externalFile, f.target)
      else await fs.link(externalFile, f.target)
    }
    await assert.rejects(applyClaude(f.options), /symbolic|hardlinked/)
    assert.equal(await fs.readFile(externalFile, 'utf8'), '{}')
  }
})

test('unsafe journals and state ancestors are rejected', async t => {
  const f = await fixture(t)
  await applyClaude(f.options)
  const privateRaw = await fs.readFile(f.journal, 'utf8')
  const external = path.join(f.root, 'journal-copy')
  await fs.writeFile(external, privateRaw)
  await fs.unlink(f.journal)
  await fs.symlink(external, f.journal)
  await assert.rejects(removeClaude({ ...f.options, force: true }), /symbolic/)
  await fs.unlink(f.journal)
  await fs.link(external, f.journal)
  await assert.rejects(inspectClaude(f.options), /hardlinked/)
})

test('atomic replacement detects concurrent edits before writing', async t => {
  const f = await fixture(t, {})
  const before = await snapshot(f.target)
  await fs.writeFile(f.target, '{"concurrent":true}')
  await assert.rejects(atomicReplace(f.target, 'replacement', before), /concurrently/)
  assert.equal(await fs.readFile(f.target, 'utf8'), '{"concurrent":true}')
})

// Opt-in only; plain installed Claude reads the native file, with no --settings or model/auth env override.
// Every writable runtime/config location is under the fixture and the only inference endpoint is loopback.
test('plain installed Claude uses native settings without helper launch flags (opt-in)', { skip: !process.env.CODING_HELPER_TEST_CLAUDE, timeout: 45000 }, async t => {
  const f = await fixture(t)
  await applyClaude({ ...f.options, model: 'fixture-public-model', key: 'loopback-dummy-key' })
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push({ url: req.url, headers: req.headers, body })
    const message = { id: 'msg_native_fixture', type: 'message', role: 'assistant', model: 'fixture-public-model', content: [{ type: 'text', text: 'NATIVE_LOOPBACK_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const settings = await f.read()
  // Intentional fixture-only drift: route the production-configured native artifact to a free local stub.
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v1`
  await fs.writeFile(f.target, serialize(settings))
  await fs.writeFile(path.join(f.options.home, '.claude.json'), serialize({ hasCompletedOnboarding: true }))
  const env = { HOME: f.options.home, USERPROFILE: f.options.home, PATH: process.env.PATH, TMPDIR: f.root, TMP: f.root, TEMP: f.root, XDG_CONFIG_HOME: path.join(f.root, 'xdg'), XDG_CACHE_HOME: path.join(f.root, 'cache'), XDG_DATA_HOME: path.join(f.root, 'data'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_MAX_RETRIES: '0' }
  if (process.platform === 'win32') {
    env.APPDATA = path.join(f.root, 'appdata')
    env.LOCALAPPDATA = path.join(f.root, 'localappdata')
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.CODING_HELPER_TEST_CLAUDE, ['-p', 'Say NATIVE_LOOPBACK_OK', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'], { env, cwd: f.root, timeout: 35000, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  assert.equal(result.code, 0, result.stderr + result.stdout)
  const request = requests.find(request => request.url.split('?')[0] === '/api/v1/v1/messages' && JSON.parse(request.body).model === 'fixture-public-model')
  assert.ok(request, 'Plain Claude did not send the native model to the loopback Messages endpoint.')
  assert.equal(request.headers.authorization, 'Bearer loopback-dummy-key')
  assert.equal(request.headers['x-api-key'], undefined)
  assert.ok(result.stdout.includes('NATIVE_LOOPBACK_OK'))
})

test('journal commit failure rolls back target without ordinary backups', async t => {
  const f = await fixture(t, { keep: 'user-content' })
  const journal = f.journal
  const targetBefore = await snapshot(f.target)
  const rename = fs.rename.bind(fs)
  let observedTemporaryTarget = false
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === journal) {
      observedTemporaryTarget = (await fs.readFile(f.target, 'utf8')) === '{"temporary":true}'
      throw Object.assign(new Error('Injected journal commit failure'), { code: 'EIO' })
    }
    return rename(source, destination)
  })
  await assert.rejects(commitPair({ target: f.target, targetBefore, targetRaw: '{"temporary":true}', journal, journalBefore: { raw: null, hash: null }, journalRaw: '{}' }), /journal commit failed.*rolled back/)
  assert.equal(observedTemporaryTarget, true)
  assert.equal(await fs.readFile(f.target, 'utf8'), targetBefore.raw)
  const entries = await fs.readdir(path.dirname(f.target))
  assert.deepEqual(entries, ['settings.json'])
})
