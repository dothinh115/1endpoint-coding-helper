import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { applyCodex, inspectCodex, removeCodex, patchCodexToml, buildCatalog, resolveCodexPaths, PROVIDER_ID, BASE_URL } from '../src/native/codex.mjs'

const key = 'sk-fixture-key-never-real'
const model = 'public-model'

async function fixture(t, initial) {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'coding-helper-codex-'))
  const home = path.join(root, 'home')
  const stateDir = path.join(root, 'state')
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
  if (initial !== undefined) await fs.writeFile(path.join(home, '.codex', 'config.toml'), initial)
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    await fs.rm(root, { recursive: true, force: true })
  })
  const options = { stateDir, env: { HOME: home }, home, platform: 'darwin' }
  return { root, home, stateDir, options, configPath: path.join(home, '.codex', 'config.toml'), catalogPath: path.join(home, '.codex', '1endpoint-models.json') }
}

const template = {
  model_messages: { instructions_template: 'You are a coding agent.', instructions_variables: {}, approvals: null, auto_review: null, permissions: null },
  shell_type: 'default',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  support_verbosity: true,
  experimental_supported_tools: [],
  visibility: 'list',
  supported_in_api: true,
}
const models = [
  { id: 'public-model', name: 'Public Model', contextWindow: 1000000, vision: true },
  { id: 'text-only', name: 'Text Only', contextWindow: null, vision: false },
]

test('path resolution honours CODEX_HOME, ~ and platform defaults', () => {
  assert.equal(resolveCodexPaths({ stateDir: '/state', env: {}, home: '/home', platform: 'darwin' }).target, '/home/.codex/config.toml')
  assert.equal(resolveCodexPaths({ stateDir: '/state', env: { CODEX_HOME: '/custom' }, home: '/home', platform: 'darwin' }).target, '/custom/config.toml')
  assert.equal(resolveCodexPaths({ stateDir: '/state', env: { CODEX_HOME: '~/alt' }, home: '/home', platform: 'darwin' }).target, '/home/alt/config.toml')
  assert.equal(resolveCodexPaths({ stateDir: '/state', env: {}, home: 'C:\\Users\\me', platform: 'win32' }).target, 'C:\\Users\\me\\.codex\\config.toml')
  assert.throws(() => resolveCodexPaths({ stateDir: '/state', env: { CODEX_HOME: 'relative/path' }, home: '/home', platform: 'darwin' }), /absolute/)
})

test('patch keeps comments, unrelated tables and root keys while managing only its own fields', () => {
  const original = [
    '# top comment',
    'approval_policy = "never"',
    'model = "old-model"',
    '',
    '[projects."/repo"]',
    'trust_level = "trusted"',
    '',
    '[model_providers.other]',
    'name = "other"',
    'base_url = "https://other.test/v1"',
    '',
  ].join('\n')
  const next = patchCodexToml(original, {
    model_provider: PROVIDER_ID,
    model,
    model_catalog_json: '/catalog.json',
    'table.name': PROVIDER_ID,
    'table.base_url': BASE_URL,
    'table.experimental_bearer_token': key,
    'table.wire_api': 'responses',
  })
  assert.match(next, /# top comment/)
  assert.match(next, /approval_policy = "never"/)
  assert.match(next, /\[projects\."\/repo"\]/)
  assert.match(next, /\[model_providers\.other\]/)
  assert.match(next, /base_url = "https:\/\/other\.test\/v1"/)
  const parsed = parse(next)
  assert.equal(parsed.model, model)
  assert.equal(parsed.model_provider, PROVIDER_ID)
  assert.equal(parsed.model_catalog_json, '/catalog.json')
  assert.deepEqual({ ...parsed.model_providers[PROVIDER_ID] }, { name: PROVIDER_ID, base_url: BASE_URL, experimental_bearer_token: key, wire_api: 'responses' })
  assert.deepEqual({ ...parsed.model_providers.other }, { name: 'other', base_url: 'https://other.test/v1' })
})

test('patch refuses malformed documents and multi-line managed values', () => {
  // Duplicate keys/tables never reach the line editor: the parser rejects them first.
  assert.throws(() => patchCodexToml('model = "a"\nmodel = "b"\n', { model: 'x' }), /Malformed Codex configuration/)
  assert.throws(() => patchCodexToml('[model_providers.1endpoint]\nname = "a"\n\n[model_providers.1endpoint]\nname = "b"\n', { model: 'x' }), /Malformed Codex configuration/)
  assert.throws(() => patchCodexToml('model = [\n  "a",\n  "b",\n]\n', { model: 'x' }), /spans multiple lines/)
  assert.throws(() => patchCodexToml('model = [\n', { model: 'x' }), /Malformed Codex configuration/)
})

test('patch removes managed keys and drops a helper-created empty provider table', () => {
  const created = patchCodexToml('approval_policy = "never"\n', {
    model_provider: PROVIDER_ID, model, model_catalog_json: null,
    'table.name': PROVIDER_ID, 'table.base_url': BASE_URL, 'table.experimental_bearer_token': key, 'table.wire_api': 'responses',
  })
  assert.match(created, /\[model_providers\.1endpoint\]/)
  const restored = patchCodexToml(created, {
    model_provider: null, model: null, model_catalog_json: null,
    'table.name': null, 'table.base_url': null, 'table.experimental_bearer_token': null, 'table.wire_api': null,
  })
  assert.equal(restored, 'approval_policy = "never"\n')
})

test('catalog carries published metadata only and never invents reasoning support', () => {
  const catalog = JSON.parse(buildCatalog(models, template))
  assert.equal(catalog.models.length, 2)
  const [vision, blind] = catalog.models
  assert.equal(vision.slug, 'public-model')
  assert.deepEqual(vision.input_modalities, ['text', 'image'])
  assert.equal(vision.context_window, 1000000)
  assert.equal(vision.max_context_window, 1000000)
  assert.equal(blind.slug, 'text-only')
  assert.deepEqual(blind.input_modalities, ['text'])
  assert.equal(blind.context_window, undefined)
  for (const entry of catalog.models) {
    assert.deepEqual(entry.supported_reasoning_levels, [])
    assert.equal(entry.supports_parallel_tool_calls, false)
    assert.equal(entry.model_messages.instructions_template, 'You are a coding agent.')
  }
  assert.equal(buildCatalog(models, null), null)
  assert.equal(buildCatalog([], template), null)
  assert.equal(buildCatalog([{ id: 'image-model', type: 'image' }], template), null)
})

test('apply writes config, catalog and a private journal; repeat apply is idempotent', async t => {
  const f = await fixture(t, 'approval_policy = "never"\n')
  const first = await applyCodex({ ...f.options, model, key, models, template })
  assert.equal(first.changed, true)
  const document = parse(await fs.readFile(f.configPath, 'utf8'))
  assert.equal(document.model, model)
  assert.equal(document.model_provider, PROVIDER_ID)
  assert.equal(document.model_catalog_json, f.catalogPath)
  assert.equal(document.approval_policy, 'never')
  const catalog = JSON.parse(await fs.readFile(f.catalogPath, 'utf8'))
  assert.equal(catalog.models.length, 2)
  const journal = JSON.parse(await fs.readFile(path.join(f.stateDir, 'native', 'codex.json'), 'utf8'))
  assert.equal(journal.tool, 'codex')
  assert.equal(journal.mode, 'direct')
  assert.equal(journal.catalog.created, true)
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.catalogPath)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(f.configPath)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.join(f.stateDir, 'native', 'codex.json'))).mode & 0o777, 0o600)
  }
  assert.equal(JSON.stringify(journal).includes('"key"'), false)
  assert.equal((await applyCodex({ ...f.options, model, key, models, template })).changed, false)
})

test('dry run writes nothing and reports the would-be change', async t => {
  const f = await fixture(t, 'model = "keep"\n')
  const before = await fs.readFile(f.configPath, 'utf8')
  const preview = await applyCodex({ ...f.options, model, key, models, template, dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.changed, false)
  assert.equal(preview.wouldChange, true)
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
  await assert.rejects(fs.stat(f.catalogPath), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(f.stateDir, 'native', 'codex.json')), { code: 'ENOENT' })
})

test('reconfiguration keeps the first baseline and removal restores it byte-for-byte', async t => {
  const original = '# keep me\napproval_policy = "never"\n\n[model_providers.other]\nname = "other"\n'
  const f = await fixture(t, original)
  await applyCodex({ ...f.options, model, key, models, template })
  await applyCodex({ ...f.options, model: 'text-only', key, models, template })
  const journal = JSON.parse(await fs.readFile(path.join(f.stateDir, 'native', 'codex.json'), 'utf8'))
  assert.deepEqual(journal.fields['root.model'].before, { present: false })
  assert.equal(journal.fields['root.model_provider'].before.present, false)
  assert.equal(parse(await fs.readFile(f.configPath, 'utf8')).model, 'text-only')
  const removed = await removeCodex({ ...f.options })
  assert.equal(removed.changed, true)
  assert.equal(await fs.readFile(f.configPath, 'utf8'), original)
  await assert.rejects(fs.stat(f.catalogPath), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(f.stateDir, 'native', 'codex.json')), { code: 'ENOENT' })
})

test('external edits are refused by apply and require force to remove', async t => {
  const f = await fixture(t, '')
  await applyCodex({ ...f.options, model, key, models, template })
  const edited = (await fs.readFile(f.configPath, 'utf8')).replace(`model = "${model}"`, 'model = "user-choice"')
  await fs.writeFile(f.configPath, edited)
  const inspected = await inspectCodex({ ...f.options })
  assert.equal(inspected.drift, true)
  assert.deepEqual(inspected.driftFields, ['root.model'])
  await assert.rejects(applyCodex({ ...f.options, model, key, models, template }), /modified outside the helper/)
  await assert.rejects(removeCodex({ ...f.options }), /requires explicit force/)
  const forced = await removeCodex({ ...f.options, force: true })
  assert.equal(forced.changed, true)
  assert.equal((await fs.readFile(f.configPath, 'utf8')).trim(), '')
})

test('an unmanaged catalog file is never overwritten', async t => {
  const f = await fixture(t, '')
  await fs.writeFile(f.catalogPath, '{"models":[]}')
  await assert.rejects(applyCodex({ ...f.options, model, key, models, template }), /unmanaged file/)
  assert.equal(await fs.readFile(f.catalogPath, 'utf8'), '{"models":[]}')
})

test('invalid keys and models fail before touching the filesystem', async t => {
  const f = await fixture(t, '')
  for (const badKey of [undefined, '', 'has space', 'line\nbreak', 'x'.repeat(8193)]) await assert.rejects(applyCodex({ ...f.options, model, key: badKey, models, template }), /valid API key/)
  for (const badModel of [undefined, '', '-flag', 'has space', 'x'.repeat(201)]) await assert.rejects(applyCodex({ ...f.options, model: badModel, key, models, template }), /Invalid public Codex model ID/)
  await assert.rejects(fs.stat(f.catalogPath), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(f.stateDir, 'native', 'codex.json')), { code: 'ENOENT' })
})

test('a client that cannot report its catalog still produces a parseable fallback catalog', async t => {
  const f = await fixture(t, '')
  const applied = await applyCodex({ ...f.options, model, key, models, template: null })
  assert.ok(applied.warnings.some(warning => /did not report its own model metadata/.test(warning)))
  const catalog = JSON.parse(await fs.readFile(f.catalogPath, 'utf8'))
  assert.equal(catalog.models.length, 2)
  for (const entry of catalog.models) {
    assert.equal(typeof entry.model_messages.instructions_template, 'string')
    assert.deepEqual(entry.supported_reasoning_levels, [])
  }
})

test('removal deletes a config.toml the helper created instead of leaving an empty stub', async t => {
  const f = await fixture(t, undefined)
  await applyCodex({ ...f.options, model, key, models, template })
  await removeCodex({ ...f.options })
  await assert.rejects(fs.stat(f.configPath), { code: 'ENOENT' })
  await assert.rejects(fs.stat(f.catalogPath), { code: 'ENOENT' })
})

test('removal keeps a pre-existing file even when every managed key is gone', async t => {
  const f = await fixture(t, '# keep this comment\n')
  await applyCodex({ ...f.options, model, key, models, template })
  await removeCodex({ ...f.options })
  assert.equal(await fs.readFile(f.configPath, 'utf8'), '# keep this comment\n')
})
