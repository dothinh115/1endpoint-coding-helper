import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyOpencodex, inspectOpencodex, removeOpencodex, opencodexRunner, opencodexDashboardUrl, syncCodexThroughOpencodex } from '../src/native/codex-opencodex.mjs'

const key = 'sk-ocx-fixture-key'
const model = 'public-model'
const models = [
  { id: 'public-model', name: 'Public Model', contextWindow: 1000000, vision: true },
  { id: 'second-model', name: 'Second Model', contextWindow: null, vision: false },
]

async function fixture(t, initial) {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'coding-helper-ocx-'))
  const stateDir = path.join(root, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    await fs.rm(root, { recursive: true, force: true })
  })
  // A stub CLI stands in for `ocx`: it holds the config document and records every invocation.
  const config = { port: 10100, providers: initial ? { '1endpoint': initial } : {} }
  const calls = []
  const exec = async ({ args, input }) => {
    calls.push(args.join(' '))
    if (args[0] === 'config' && args[1] === 'export') return { code: 0, stdout: JSON.stringify(config), stderr: '' }
    if (args[0] === 'config' && args[1] === 'import') { Object.assign(config, JSON.parse(input)); return { code: 0, stdout: '{"ok":true}', stderr: '' } }
    if (args[0] === 'sync') return { code: 0, stdout: 'Models synced to Codex.', stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  return { root, stateDir, config, calls, exec }
}

test('dashboard URL falls back to the default port for invalid values', () => {
  assert.equal(opencodexDashboardUrl(10100), 'http://localhost:10100/')
  assert.equal(opencodexDashboardUrl(0), 'http://localhost:10100/')
  assert.equal(opencodexDashboardUrl('nope'), 'http://localhost:10100/')
  assert.equal(opencodexDashboardUrl(8080), 'http://localhost:8080/')
})

test('setup registers the provider with every catalog model and restores the previous entry', async t => {
  const previous = { adapter: 'openai-chat', baseUrl: 'https://old.test/v1', apiKey: 'sk-old', defaultModel: 'old-model' }
  const f = await fixture(t, previous)
  const applied = await applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model, models })
  assert.equal(applied.changed, true)
  assert.equal(applied.modelCount, 2)
  assert.equal(applied.dashboardUrl, 'http://localhost:10100/')
  const provider = f.config.providers['1endpoint']
  assert.equal(provider.baseUrl, 'https://1endpoint.dev/api/v1')
  assert.equal(provider.apiKey, key)
  assert.equal(provider.defaultModel, model)
  assert.deepEqual(provider.models, ['public-model', 'second-model'])
  assert.deepEqual(provider.selectedModels, ['public-model', 'second-model'])
  assert.equal(provider.initialModelSelection.status, 'ready')
  assert.equal(provider.initialModelSelection.modelCount, 2)
  assert.deepEqual(provider.modelContextWindows, { 'public-model': 1000000 })
  assert.deepEqual(provider.noVisionModels, ['second-model'])
  const journal = JSON.parse(await fs.readFile(path.join(f.stateDir, 'native', 'opencodex.json'), 'utf8'))
  assert.deepEqual(journal.previous, previous)
  assert.equal(JSON.stringify(journal).includes('"previous"') && journal.applied.apiKey === key, true)

  // Idempotent: a repeat run changes nothing and keeps the original baseline.
  const repeat = await applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model, models })
  assert.equal(repeat.changed, false)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.stateDir, 'native', 'opencodex.json'), 'utf8')).previous, previous)

  const removed = await removeOpencodex({ stateDir: f.stateDir, exec: f.exec })
  assert.equal(removed.changed, true)
  assert.deepEqual(f.config.providers['1endpoint'], previous)
  await assert.rejects(fs.stat(path.join(f.stateDir, 'native', 'opencodex.json')), { code: 'ENOENT' })
})

test('a provider that did not exist before is deleted on removal', async t => {
  const f = await fixture(t, null)
  await applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model, models })
  assert.ok(f.config.providers['1endpoint'])
  await removeOpencodex({ stateDir: f.stateDir, exec: f.exec })
  assert.equal(f.config.providers['1endpoint'], undefined)
})

test('external provider edits block setup and removal until forced', async t => {
  const f = await fixture(t, null)
  await applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model, models })
  f.config.providers['1endpoint'] = { ...f.config.providers['1endpoint'], apiKey: 'sk-user-changed' }
  const inspected = await inspectOpencodex({ stateDir: f.stateDir, exec: f.exec })
  assert.equal(inspected.drift, true)
  await assert.rejects(applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model, models }), /modified outside the helper/)
  await assert.rejects(removeOpencodex({ stateDir: f.stateDir, exec: f.exec }), /requires explicit force/)
  const forced = await removeOpencodex({ stateDir: f.stateDir, exec: f.exec, force: true })
  assert.equal(forced.drift, true)
  assert.equal(f.config.providers['1endpoint'], undefined)
})

test('dry run performs no import and writes no journal', async t => {
  const f = await fixture(t, null)
  const preview = await applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model, models, dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.changed, false)
  assert.equal(f.calls.some(call => call.startsWith('config import')), false)
  assert.equal(f.config.providers['1endpoint'], undefined)
  await assert.rejects(fs.stat(path.join(f.stateDir, 'native', 'opencodex.json')), { code: 'ENOENT' })
})

test('inspection without a journal reports unconfigured and never invokes the CLI', async t => {
  const f = await fixture(t, null)
  assert.deepEqual(await inspectOpencodex({ stateDir: f.stateDir, exec: f.exec }), { configured: false, drift: false })
  assert.deepEqual(f.calls, [])
})

test('invalid key, model and missing CLI are rejected before any invocation', async t => {
  const f = await fixture(t, null)
  await assert.rejects(applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key: 'has space', model, models }), /valid API key/)
  await assert.rejects(applyOpencodex({ stateDir: f.stateDir, exec: f.exec, key, model: 'bad model', models }), /Invalid public Codex model ID/)
  await assert.rejects(applyOpencodex({ stateDir: f.stateDir, key, model, models }), /OpenCodex CLI is required/)
  assert.deepEqual(f.calls, [])
})

test('sync is reported as failed when the CLI refuses the Codex write', async t => {
  const ok = async () => ({ code: 0, stdout: 'Models synced to Codex.\n', stderr: '' })
  assert.deepEqual(await syncCodexThroughOpencodex(ok), { ok: true, detail: null })
  const refused = async () => ({ code: 0, stdout: 'Codex write refused (service-home): ...\nCodex sync did not complete.\n', stderr: '' })
  const result = await syncCodexThroughOpencodex(refused)
  assert.equal(result.ok, false)
  assert.match(result.detail, /refused|did not complete/i)
})

test('runner never puts the key in argv and bounds its output', async t => {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'coding-helper-ocx-run-'))
  t.after(async () => { assert.equal(path.dirname(root), base); await fs.rm(root, { recursive: true, force: true }) })
  const bin = path.join(root, 'ocx')
  await fs.writeFile(bin, `#!${process.execPath}\nlet data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:data}))})\n`, { mode: 0o700 })
  const exec = opencodexRunner({ ocxBin: bin })
  const result = await exec({ args: ['config', 'import', '-', '--yes'], input: `{"providers":{}}\n` })
  assert.equal(result.code, 0)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.args, ['config', 'import', '-', '--yes'])
  assert.equal(payload.stdin.includes('providers'), true)
})
