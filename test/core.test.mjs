import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'
import YAML from 'yaml'
import { setup, reconfigure, remove, backup, loadState, stateRoot, planFor, validateModel, assertSafePath } from '../src/state.mjs'
import { createClaudePlan, MODEL_VARIABLES } from '../src/adapters/claude.mjs'
import { parse } from '../src/cli.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const secret = 'fixture-secret-NEVER-PERSIST-19327'
async function fixture(t) {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'coding-helper-core-'))
  assert.equal(path.dirname(root), base)
  assert.ok(path.basename(root).startsWith('coding-helper-core-'))
  t.after(async () => {
    // Cleanup never follows a computed/unvalidated external path.
    assert.equal(path.dirname(root), base)
    assert.ok(path.isAbsolute(root) && path.basename(root).startsWith('coding-helper-core-'))
    assert.equal(await fs.realpath(root), root)
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}
async function exists(file) { try { await fs.lstat(file); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
async function snapshot(root) {
  const result = {}
  if (!await exists(root)) return result
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) Object.assign(result, await snapshot(file))
    else if (entry.isFile()) result[file] = await fs.readFile(file, 'utf8')
    else result[file] = `symlink:${await fs.readlink(file)}`
  }
  return result
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, ...options })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}
async function cliEnv(root) {
  const home = path.join(root, 'actual-home')
  await fs.mkdir(home, { recursive: true })
  const bin = path.join(root, 'installed-bin')
  await fs.mkdir(bin)
  for (const tool of ['dsh', 'claude']) await fs.writeFile(path.join(bin, tool), `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o700 })
  return { PATH: bin, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_CONFIG_DIR: path.join(root, 'native-claude'), DSH_HOME: path.join(root, 'native-dsh'), ONEENDPOINT_HELPER_HOME: path.join(root, 'state'), ONEENDPOINT_API_KEY: secret }
}

test('model validation accepts public IDs and refuses injection or ambiguous IDs', () => {
  for (const model of ['gpt-5', 'anthropic/claude-sonnet-4.6', 'team:model+rev_1', 'x'.repeat(200)]) assert.equal(validateModel(model), model)
  for (const model of [undefined, null, 1, '', '-flag', 'has space', 'x\ny', 'x\0y', 'x"', '../escape', 'x'.repeat(201)]) assert.throws(() => validateModel(model))
  assert.equal(stateRoot({ ONEENDPOINT_HELPER_HOME: '/tmp/isolated-helper' }), '/tmp/isolated-helper')
  assert.throws(() => planFor({ stateDir: '/tmp', tool: 'unknown', model: 'x' }))
})

for (const tool of ['claude', 'dsh']) {
  test(`${tool}: dry run writes nothing; setup preserves existing actual homes`, async t => {
    const root = await fixture(t), stateDir = path.join(root, 'state')
    const home = path.join(root, 'actual-home')
    await fs.mkdir(path.join(home, '.claude'), { recursive: true })
    await fs.mkdir(path.join(home, '.dsh'), { recursive: true })
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), '{"private":"original"}')
    await fs.writeFile(path.join(home, '.dsh', 'config.yml'), 'private: original\n')
    const before = await snapshot(home)
    const preview = await setup({ stateDir, tool, model: 'public/model', dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.equal(await exists(stateDir), false)
    assert.equal((await setup({ stateDir, tool, model: 'public/model' })).changed, true)
    assert.deepEqual(await snapshot(home), before)
    const { state, plan } = await loadState(stateDir, tool)
    assert.equal(state.model, 'public/model')
    for (const file of [...plan.files.map(file => file.path), path.join(stateDir, `${tool}.json`)]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700)
    assert.ok(!JSON.stringify(await snapshot(stateDir)).includes(secret))
  })

  test(`${tool}: idempotent setup, explicit update, and immutable backup integrity`, async t => {
    const root = await fixture(t), stateDir = path.join(root, 'state')
    await setup({ stateDir, tool, model: 'model-a' })
    const first = await snapshot(stateDir)
    const generated = planFor({ stateDir, tool, model: 'model-a' }).files[0].path
    const beforeStat = await fs.stat(generated)
    assert.equal((await setup({ stateDir, tool, model: 'model-a' })).changed, false)
    assert.deepEqual(await snapshot(stateDir), first)
    assert.equal((await fs.stat(generated)).mtimeMs, beforeStat.mtimeMs)
    await assert.rejects(setup({ stateDir, tool, model: 'model-b' }), /--update/)
    assert.deepEqual(await snapshot(stateDir), first)
    const saved = await backup({ stateDir, tool })
    const bytes = await fs.readFile(saved, 'utf8'), parsed = JSON.parse(bytes)
    assert.equal(parsed.model, 'model-a')
    assert.deepEqual(parsed.files, planFor({ stateDir, tool, model: 'model-a' }).files)
    assert.equal((await fs.stat(saved)).mode & 0o777, 0o600)
    await setup({ stateDir, tool, model: 'model-b', update: true })
    assert.equal((await loadState(stateDir, tool)).state.model, 'model-b')
    assert.equal(await fs.readFile(saved, 'utf8'), bytes)
    assert.equal(await exists(path.join(stateDir, '.setup.lock')), false)
  })

  test(`${tool}: malformed, unknown and forged manifests are refused without writes`, async t => {
    const root = await fixture(t), stateDir = path.join(root, 'state')
    await setup({ stateDir, tool, model: 'public-model' })
    const manifest = path.join(stateDir, `${tool}.json`), original = JSON.parse(await fs.readFile(manifest, 'utf8'))
    for (const value of ['{bad', 'null', '[]', '{}', JSON.stringify({ ...original, injected: true }), JSON.stringify({ ...original, tool: 'other' }), JSON.stringify({ ...original, files: [{ path: '/outside', hash: 'forged' }] }), JSON.stringify({ ...original, model: 'bad\nmodel' })]) {
      await fs.writeFile(manifest, value)
      const before = await snapshot(stateDir)
      await assert.rejects(loadState(stateDir, tool))
      await assert.rejects(setup({ stateDir, tool, model: 'new-model', update: true }))
      await assert.rejects(backup({ stateDir, tool }))
      assert.deepEqual(await snapshot(stateDir), before)
    }
  })

  test(`${tool}: unmanaged targets and modified or missing owned files are refused`, async t => {
    const root = await fixture(t), stateDir = path.join(root, 'state')
    const target = planFor({ stateDir, tool, model: 'public-model' }).files[0].path
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'unmanaged-private-file')
    const before = await snapshot(stateDir)
    await assert.rejects(setup({ stateDir, tool, model: 'public-model' }), /Unmanaged/)
    assert.deepEqual(await snapshot(stateDir), before)
    // The deletion target is a known generated file strictly inside the validated fixture.
    assert.ok(target.startsWith(root + path.sep)); await fs.unlink(target)
    await setup({ stateDir, tool, model: 'public-model' })
    await fs.appendFile(target, '\nmodified')
    await assert.rejects(loadState(stateDir, tool), /modified/)
    await assert.rejects(setup({ stateDir, tool, model: 'public-model', update: true }), /modified/)
    assert.ok(target.startsWith(root + path.sep)); await fs.unlink(target)
    await assert.rejects(loadState(stateDir, tool), /modified/)
  })
}

test('symlink state roots, ancestors, manifests, generated files and backup dirs are refused', async t => {
  const root = await fixture(t), real = path.join(root, 'real'), linked = path.join(root, 'linked')
  await fs.mkdir(real); await fs.symlink(real, linked)
  await assert.rejects(assertSafePath(path.join(linked, 'nested')), /symbolic link/)
  await assert.rejects(setup({ stateDir: linked, tool: 'claude', model: 'x' }), /symbolic link/)
  for (const kind of ['manifest', 'file', 'backups']) {
    const stateDir = path.join(root, kind)
    await setup({ stateDir, tool: 'claude', model: 'x' })
    const target = kind === 'manifest' ? path.join(stateDir, 'claude.json') : kind === 'file' ? planFor({ stateDir, tool: 'claude', model: 'x' }).files[0].path : path.join(stateDir, 'backups')
    const external = path.join(real, kind)
    if (kind !== 'backups') {
      await fs.copyFile(target, external)
      assert.ok(target.startsWith(root + path.sep)); await fs.unlink(target)
    } else await fs.mkdir(external)
    await fs.symlink(external, target)
    const before = await snapshot(real)
    await assert.rejects(kind === 'backups' ? backup({ stateDir, tool: 'claude' }) : loadState(stateDir, 'claude'), /symbolic link/)
    assert.deepEqual(await snapshot(real), before)
  }
})

test('exclusive setup lock refuses concurrent writers/backups and never removes someone else lock', async t => {
  const root = await fixture(t), stateDir = path.join(root, 'state')
  await setup({ stateDir, tool: 'claude', model: 'x' })
  const lock = path.join(stateDir, '.setup.lock')
  await fs.writeFile(lock, 'other-writer')
  const before = await snapshot(stateDir)
  await assert.rejects(setup({ stateDir, tool: 'claude', model: 'new', update: true }), /active/)
  await assert.rejects(backup({ stateDir, tool: 'claude' }), /active/)
  assert.deepEqual(await snapshot(stateDir), before)
  assert.ok(lock.startsWith(root + path.sep)); await fs.unlink(lock)
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => setup({ stateDir, tool: 'claude', model: 'new', update: true })))
  assert.ok(results.some(r => r.status === 'fulfilled'))
  assert.ok(results.some(r => r.status === 'rejected'))
  assert.equal((await loadState(stateDir, 'claude')).state.model, 'new')
  assert.equal(await exists(lock), false)
})

for (const tool of ['claude', 'dsh']) {
  test(`${tool}: reconfigure auto-backup, remove preview/confirmation and fixed-path forced recovery`, async t => {
    const root = await fixture(t), stateDir = path.join(root, 'state')
    await setup({ stateDir, tool, model: 'old' })
    const before = await snapshot(stateDir)
    await reconfigure({ stateDir, tool, model: 'new', dryRun: true })
    assert.deepEqual(await snapshot(stateDir), before)
    await reconfigure({ stateDir, tool, model: 'new' })
    const backups = await snapshot(path.join(stateDir, 'backups'))
    assert.equal(Object.keys(backups).length, 1)
    assert.equal(JSON.parse(Object.values(backups)[0]).model, 'old')
    await reconfigure({ stateDir, tool, model: 'new' })
    assert.deepEqual(await snapshot(path.join(stateDir, 'backups')), backups)
    const home = path.join(stateDir, tool, 'home')
    await fs.mkdir(home); await fs.writeFile(path.join(home, 'runtime'), 'keep')
    await fs.writeFile(path.join(stateDir, 'unknown'), 'keep')
    const configured = await snapshot(stateDir)
    await assert.rejects(remove({ stateDir, tool }), /--yes/)
    await remove({ stateDir, tool, dryRun: true })
    assert.deepEqual(await snapshot(stateDir), configured)
    const target = planFor({ stateDir, tool, model: 'new' }).files[0].path
    await fs.writeFile(target, secret)
    await assert.rejects(remove({ stateDir, tool, yes: true }), /modified/)
    await fs.writeFile(path.join(stateDir, `${tool}.json`), JSON.stringify({ files: [{ path: path.join(home, 'runtime') }] }))
    await remove({ stateDir, tool, yes: true, force: true })
    assert.equal(await exists(target), false)
    assert.equal(await exists(path.join(stateDir, `${tool}.json`)), false)
    assert.equal(await fs.readFile(path.join(home, 'runtime'), 'utf8'), 'keep')
    assert.equal(await fs.readFile(path.join(stateDir, 'unknown'), 'utf8'), 'keep')
    assert.deepEqual(await snapshot(path.join(stateDir, 'backups')), backups)
    assert.ok(!JSON.stringify(await snapshot(stateDir)).includes(secret))
    assert.equal((await remove({ stateDir, tool, yes: true })).changed, false)
    await setup({ stateDir, tool, model: 'fresh' })
    const outside = path.join(root, 'outside'); await fs.writeFile(outside, 'keep')
    assert.ok(target.startsWith(root + path.sep)); await fs.unlink(target)
    await fs.symlink(outside, target)
    await assert.rejects(remove({ stateDir, tool, yes: true, force: true }), /symbolic link/)
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep')
  })
}

test('CLI package-bin symlink invocation executes help/version', async t => {
  const root = await fixture(t), env = await cliEnv(root), linked = path.join(root, 'coding-helper')
  await fs.symlink(cli, linked)
  const result = await run(process.execPath, [linked, '--version'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^\d+\.\d+\.\d+/)
})

test('CLI lifecycle commands confirm deletion and automatically back up model changes', async t => {
  const root = await fixture(t), env = await cliEnv(root)
  for (const args of [ ['setup', '--tool', 'claude', '--model', 'old'], ['reconfigure', '--tool', 'claude', '--model', 'new'], ['remove', '--tool', 'claude', '--dry-run'] ]) {
    const result = await run(process.execPath, [cli, ...args], { env }); assert.equal(result.code, 0, result.stderr)
  }
  const refused = await run(process.execPath, [cli, 'remove', '--tool', 'claude'], { env })
  assert.equal(refused.code, 1); assert.ok(refused.stderr.includes('--yes'))
  const removed = await run(process.execPath, [cli, 'remove', '--tool', 'claude', '--yes'], { env })
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(await exists(path.join(env.ONEENDPOINT_HELPER_HOME, 'claude.json')), false)
  assert.equal(Object.keys(await snapshot(path.join(env.ONEENDPOINT_HELPER_HOME, 'backups'))).length, 1)
})

test('Claude distinct tier mappings survive setup, reconfigure and backup', async t => {
  const root = await fixture(t), stateDir = path.join(root, 'state'), tool = 'claude'
  const roles = { haiku: 'fast', sonnet: 'balanced', opus: 'strong', fable: 'future' }
  await setup({ stateDir, tool, model: 'balanced', roles })
  const loaded = await loadState(stateDir, tool)
  assert.deepEqual(loaded.state.roles, roles)
  const settings = JSON.parse(loaded.plan.files[0].content)
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'fast')
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'balanced')
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'strong')
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'future')
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'balanced')
  assert.equal((await setup({ stateDir, tool, model: 'balanced', roles })).changed, false)
  const changedRoles = { ...roles, haiku: 'faster' }
  await assert.rejects(setup({ stateDir, tool, model: 'balanced', roles: changedRoles }), /--update/)
  await reconfigure({ stateDir, tool, model: 'balanced', roles: changedRoles })
  const saved = Object.values(await snapshot(path.join(stateDir, 'backups')))
  assert.deepEqual(JSON.parse(saved[0]).roles, roles)
  for (const invalid of [null, [], { bad: 'x' }, { haiku: 'invalid space' }]) assert.throws(() => planFor({ stateDir, tool, model: 'x', roles: invalid }))
  assert.throws(() => planFor({ stateDir, tool: 'dsh', model: 'x', roles }))
})

test('Claude maps all model roles through the native settings file', () => {
  const plan = createClaudePlan({ stateDir: '/isolated', model: 'public-model' })
  const settings = JSON.parse(plan.files[0].content)
  for (const name of MODEL_VARIABLES) { assert.equal(settings.env[name], 'public-model'); assert.equal(plan.env[name], 'public-model') }
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://1endpoint.dev/api/v1')
  assert.equal(settings.model, 'public-model')
  assert.deepEqual(plan.args.slice(0, 2), ['--setting-sources', 'user'])
})

for (const tool of ['dsh', 'claude']) test(`${tool}: missing CLI rejects setup/reconfigure before reading or writing user state`, async t => {
  const root = await fixture(t), env = await cliEnv(root)
  const bin = path.join(root, 'empty-bin')
  await fs.mkdir(bin)
  env.PATH = bin
  const before = await snapshot(root)
  for (const args of [['setup', '--model', 'public-model'], ['reconfigure', '--model', 'public-model']]) {
    const result = await run(process.execPath, [cli, ...args, '--tool', tool], { env })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /is not installed or/)
    assert.match(result.stderr, /Install it first/)
    assert.ok(result.stderr.includes(tool === 'dsh' ? 'DeepSeek Harness (DSH)' : 'Claude Code'))
    assert.ok(result.stderr.includes(tool === 'dsh' ? 'https://github.com/deepseek-ai/deepseek-harness' : 'https://code.claude.com/docs/en/overview'))
    assert.ok(!result.stderr.includes(secret))
    assert.deepEqual(await snapshot(root), before)
  }
  const removal = await run(process.execPath, [cli, 'remove', '--tool', tool, '--yes'], { env })
  assert.equal(removal.code, 0, removal.stderr)
})

test('CLI help/version and noninteractive errors do not expose supplied values or create state', async t => {
  const root = await fixture(t), env = await cliEnv(root)
  for (const args of [['--help'], ['-h'], ['--version'], ['-v']]) {
    const result = await run(process.execPath, [cli, ...args], { env })
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.stdout.trim())
  }
  for (const args of [[], ['wat', secret], ['setup', '--tool', 'claude'], ['setup', '--tool', 'evil', '--model', secret], ['setup', '--tool', 'claude', '--model', 'bad\n' + secret], ['setup', '--tool', 'claude', '--api-key', secret], ['doctor', '--tool', 'claude', '--tool', 'claude'], ['backup', '--tool', 'claude', '--', secret]]) {
    const result = await run(process.execPath, [cli, ...args], { env })
    assert.equal(result.code, 1)
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret))
  }
  assert.equal(await exists(env.ONEENDPOINT_HELPER_HOME), false)
  assert.throws(() => parse(['setup', '--tool', 'claude', '--dry-run', '--dry-run']))
})

for (const tool of ['claude', 'dsh']) {
  test(`${tool}: legacy metadata migrates on repeated setup; reconfigure/remove restore native values and preserve edits`, async t => {
    const root = await fixture(t), env = await cliEnv(root), stateDir = env.ONEENDPOINT_HELPER_HOME
    const claudePath = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json')
    const dshPath = path.join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
    const envPath = path.join(env.DSH_HOME, '.env')
    const originalClaude = { model: 'previous-model', apiKeyHelper: 'previous-key-helper', permissions: { allow: ['Read'], deny: ['Bash'] }, hooks: { Stop: [] }, env: { ANTHROPIC_AUTH_TOKEN: 'previous-fixture-token', ANTHROPIC_DEFAULT_SONNET_MODEL: 'previous-sonnet', UNRELATED: 'keep' } }
    const originalDsh = [
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { '1endpoint': { baseURL: 'https://previous.invalid', models: [{ id: 'previous-model' }] }, unrelated: { baseURL: 'https://unrelated.invalid' } } } },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'previous-provider', model: 'previous-model', unrelated: 'keep' } },
      { id: 'permission-policy', config: { allow: ['read'], deny: ['shell'] } },
    ]
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.mkdir(path.dirname(dshPath), { recursive: true })
    await fs.writeFile(claudePath, JSON.stringify(originalClaude))
    await fs.writeFile(dshPath, YAML.stringify(originalDsh))
    await fs.writeFile(envPath, 'ONEENDPOINT_API_KEY="previous-fixture-key"\nUNRELATED=keep\n')
    // Compatibility setup still creates only helper-owned metadata; migration happens at CLI boundary.
    await setup({ stateDir, tool, model: 'old' })
    const legacy = await snapshot(stateDir), nativeBefore = await snapshot(tool === 'claude' ? env.CLAUDE_CONFIG_DIR : env.DSH_HOME)
    const invoke = args => run(process.execPath, [cli, ...args, '--tool', tool], { env })
    let result = await invoke(['setup', '--model', 'old', '--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await snapshot(stateDir), legacy)
    assert.deepEqual(await snapshot(tool === 'claude' ? env.CLAUDE_CONFIG_DIR : env.DSH_HOME), nativeBefore)
    result = await invoke(['setup', '--model', 'old'])
    assert.equal(result.code, 0, result.stderr)
    if (tool === 'claude') {
      const settings = JSON.parse(await fs.readFile(claudePath, 'utf8'))
      assert.equal(settings.model, 'old')
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN === secret, true)
      assert.deepEqual(settings.permissions, originalClaude.permissions)
      settings.theme = 'late-edit'; settings.env.UNRELATED = 'edited'
      await fs.writeFile(claudePath, JSON.stringify(settings))
    } else {
      const rows = YAML.parse(await fs.readFile(dshPath, 'utf8'))
      assert.equal(rows[1].config.model, 'old')
      assert.equal((await fs.readFile(envPath, 'utf8')).includes(JSON.stringify(secret)), true)
      rows[1].config.unrelated = 'edited'; rows.push({ id: 'late-edit', config: { enabled: true } })
      await fs.writeFile(dshPath, YAML.stringify(rows))
      await fs.appendFile(envPath, 'LATE_EDIT=keep\n')
    }
    const applied = await snapshot(root)
    result = await invoke(['setup', '--model', 'old'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await snapshot(root), applied)
    result = await invoke(['setup', '--model', 'new'])
    assert.equal(result.code, 1)
    assert.deepEqual(await snapshot(root), applied)
    result = await invoke(['reconfigure', '--model', 'new'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await loadState(stateDir, tool)).state.model, 'new')
    const changed = await snapshot(root)
    result = await invoke(['remove', '--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await snapshot(root), changed)
    result = await invoke(['remove', '--yes'])
    assert.equal(result.code, 0, result.stderr)
    if (tool === 'claude') {
      assert.deepEqual(JSON.parse(await fs.readFile(claudePath, 'utf8')), { ...originalClaude, theme: 'late-edit', env: { ...originalClaude.env, UNRELATED: 'edited' } })
    } else {
      const expected = structuredClone(originalDsh)
      expected[1].config.unrelated = 'edited'; expected.push({ id: 'late-edit', config: { enabled: true } })
      assert.deepEqual(YAML.parse(await fs.readFile(dshPath, 'utf8')), expected)
      assert.equal(await fs.readFile(envPath, 'utf8'), 'ONEENDPOINT_API_KEY="previous-fixture-key"\nUNRELATED=keep\nLATE_EDIT=keep\n')
    }
    assert.equal(await exists(path.join(stateDir, 'native', `${tool}.json`)), false)
    assert.equal(await exists(path.join(stateDir, `${tool}.json`)), false)
    // The other tool's explicitly isolated native files never change.
    if (tool === 'claude') assert.deepEqual(YAML.parse(await fs.readFile(dshPath, 'utf8')), originalDsh)
    else assert.deepEqual(JSON.parse(await fs.readFile(claudePath, 'utf8')), originalClaude)
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret))
  })
}

