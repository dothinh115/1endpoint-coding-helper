import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import JSON5 from 'json5'
import { applyAgent, inspectAgent, removeAgent, resolveAgentPath } from '../src/native/agents.mjs'

async function fixture(t, tool, original) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'native-agents-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const options = { tool, stateDir: path.join(root, 'state'), home: path.join(root, 'home'), env: {}, model: 'public/model', key: 'dummy-agent-token' }
  const target = resolveAgentPath(options)
  if (original !== undefined) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, typeof original === 'string' ? original : JSON.stringify(original))
  }
  const read = async () => (tool === 'hermes' ? YAML : JSON5).parse(await fs.readFile(target, 'utf8'))
  return { root, options, target, read }
}

for (const tool of ['openclaw', 'hermes']) {
  test(`${tool}: native setup, idempotence, rotation and selective restoration`, async t => {
    const original = tool === 'openclaw'
      ? { models: { providers: { other: { baseUrl: 'https://other.invalid' } } }, agents: { defaults: { model: { primary: 'old/model', fallbacks: ['other/model'] }, models: { 'other/model': {} } } }, tools: { profile: 'minimal' } }
      : { providers: { other: { base_url: 'https://other.invalid' } }, model: { provider: 'other', default: 'old/model', base_url: 'https://old.invalid', api_key: 'old-dummy-key', temperature: 0.4 }, terminal: { theme: 'plain' } }
    const f = await fixture(t, tool, original)
    assert.equal((await applyAgent({ ...f.options, dryRun: true })).wouldChange, true)
    assert.deepEqual(await f.read(), original)
    const applied = await applyAgent(f.options)
    assert.equal(applied.configured, true)
    assert.equal(JSON.stringify(applied).includes(f.options.key), false)
    assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600)
    assert.equal((await applyAgent(f.options)).changed, false)
    assert.equal((await inspectAgent(f.options)).drift, false)
    const config = await f.read()
    if (tool === 'openclaw') {
      assert.equal(config.models.providers['1endpoint'].api, 'openai-completions')
      assert.equal(config.models.providers['1endpoint'].apiKey, f.options.key)
      assert.equal(config.agents.defaults.model.primary, '1endpoint/public/model')
      assert.deepEqual(config.agents.defaults.model.fallbacks, [])
      config.models.providers.other.extra = 'late edit'
    } else {
      assert.equal(config.providers['1endpoint'].api_mode, 'chat_completions')
      assert.equal(config.providers['1endpoint'].api_key, f.options.key)
      assert.equal(config.model.provider, 'custom:1endpoint')
      assert.equal(config.model.default, f.options.model)
      assert.equal(config.model.temperature, 0.4)
      config.providers.other.extra = 'late edit'
    }
    await fs.writeFile(f.target, JSON.stringify(config))
    await applyAgent({ ...f.options, model: 'next-model', key: 'rotated-dummy-key' })
    await removeAgent(f.options)
    const expected = structuredClone(original)
    ;(tool === 'openclaw' ? expected.models.providers : expected.providers).other.extra = 'late edit'
    assert.deepEqual(await f.read(), expected)
    assert.equal((await inspectAgent(f.options)).configured, false)
  })

  test(`${tool}: drift, force, malformed input, symlink and lock negative paths`, async t => {
    const f = await fixture(t, tool)
    await applyAgent(f.options)
    const config = await f.read()
    ;(tool === 'openclaw' ? config.models.providers : config.providers)['1endpoint'].baseUrl = 'drift'
    config.keep = true
    await fs.writeFile(f.target, JSON.stringify(config))
    assert.equal((await inspectAgent(f.options)).drift, true)
    await assert.rejects(applyAgent(f.options), /modified/)
    await assert.rejects(removeAgent(f.options), /force/)
    await removeAgent({ ...f.options, force: true })
    assert.deepEqual(await f.read(), { keep: true })
    await fs.writeFile(f.target, 'invalid: [')
    await assert.rejects(applyAgent(f.options), /Malformed/)
    assert.equal((await removeAgent(f.options)).changed, false)
    await fs.unlink(f.target)
    const linked = path.join(f.root, 'linked')
    await fs.writeFile(linked, '{}')
    await fs.symlink(linked, f.target)
    await assert.rejects(applyAgent(f.options), /symbolic/)
    await fs.unlink(f.target)
    await fs.writeFile(path.join(f.options.stateDir, '.setup.lock'), '')
    await assert.rejects(applyAgent(f.options), /active/)
  })

  test(`${tool}: missing journal is non-mutating; new config removes cleanly`, async t => {
    const f = await fixture(t, tool)
    assert.equal((await removeAgent(f.options)).changed, false)
    await assert.rejects(fs.stat(f.options.stateDir), { code: 'ENOENT' })
    await applyAgent(f.options)
    await removeAgent(f.options)
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' })
    await assert.rejects(applyAgent({ ...f.options, key: 'bad\nkey' }), /key/)
  })
}

test('native home overrides are absolute and platform-aware', () => {
  assert.equal(resolveAgentPath({ tool: 'openclaw', home: '/home/u', env: {} }), '/home/u/.openclaw/openclaw.json')
  assert.equal(resolveAgentPath({ tool: 'openclaw', home: '/home/u', env: { OPENCLAW_HOME: '/custom' } }), '/custom/.openclaw/openclaw.json')
  assert.equal(resolveAgentPath({ tool: 'openclaw', home: '/home/u', env: { OPENCLAW_STATE_DIR: '~/state', OPENCLAW_CONFIG_PATH: '/config/file.json' } }), '/config/file.json')
  assert.equal(resolveAgentPath({ tool: 'hermes', home: '/home/u', env: { HERMES_HOME: '~/hermes' } }), '/home/u/hermes/config.yaml')
  assert.equal(resolveAgentPath({ tool: 'hermes', platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'C:\\Local' } }), 'C:\\Local\\hermes\\config.yaml')
  for (const tool of ['openclaw', 'hermes']) assert.throws(() => resolveAgentPath({ tool, home: '/home/u', env: { OPENCLAW_STATE_DIR: 'relative', HERMES_HOME: 'relative' } }), /absolute/)
})

test('OpenClaw refuses implicit legacy-path shadowing', async t => {
  const f = await fixture(t, 'openclaw')
  const legacy = path.join(f.options.home, '.clawdbot', 'clawdbot.json')
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await fs.writeFile(legacy, '{"keep":"legacy"}')
  await assert.rejects(applyAgent(f.options), /explicit OPENCLAW_CONFIG_PATH/)
  assert.equal(await fs.readFile(legacy, 'utf8'), '{"keep":"legacy"}')
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' })
})

test('OpenClaw JSON5 is supported and include directives fail closed', async t => {
  const f = await fixture(t, 'openclaw', "{ // comment\n tools: { profile: 'minimal', }, }")
  await applyAgent(f.options)
  assert.equal((await f.read()).tools.profile, 'minimal')
  await removeAgent(f.options)
  await fs.writeFile(f.target, '{"models":{"$include":"private.json"}}')
  await assert.rejects(applyAgent(f.options), /include/)
})
