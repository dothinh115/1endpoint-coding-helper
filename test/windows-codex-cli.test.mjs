import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'smol-toml'

const cliUrl = new URL('../src/cli.mjs', import.meta.url).href
const key = 'sk-windows-codex-fixture-never-real'
const instructions = 'Installed Windows Codex instructions, not the generic fallback.'

// Run the public CLI dispatcher in a child process with its wizard-supplied catalog context.
// This exercises the real .cmd runner without fetching the public catalog or using real keys.
test('Windows direct Codex CLI setup, doctor, reconfigure and removal with a real .cmd shim', { skip: process.platform !== 'win32' }, async t => {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'coding-helper-windows-codex đường 模型-'))
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    await fs.rm(root, { recursive: true, force: true })
  })
  const home = path.join(root, 'user home')
  const codexHome = path.join(root, 'native Codex home')
  const stateDir = path.join(root, 'helper state')
  const bin = path.join(root, 'npm bin đường 模型')
  const temp = path.join(root, 'temporary homes')
  for (const directory of [home, codexHome, bin, temp]) await fs.mkdir(directory)
  const env = {
    SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: bin,
    TEMP: temp,
    TMP: temp,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(root, 'unused claude'),
    DSH_HOME: path.join(root, 'unused dsh'),
    OPENCLAW_STATE_DIR: path.join(root, 'unused openclaw'),
    HERMES_HOME: path.join(root, 'unused hermes'),
    ONEENDPOINT_HELPER_HOME: stateDir,
    ONEENDPOINT_API_KEY: key,
    NO_COLOR: '1',
  }
  const config = path.join(codexHome, 'config.toml')
  const auth = path.join(codexHome, 'auth.json')
  const catalog = path.join(codexHome, '1endpoint-models.json')
  const original = '# preserved Windows preferences\napproval_policy = "never"\n'
  const originalAuth = '{"fixture":"existing login must be preserved"}\n'
  await fs.writeFile(config, original)
  await fs.writeFile(auth, originalAuth)
  await fs.writeFile(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "%~dp0codex-fixture.mjs" %*\r\n`)
  await fs.writeFile(path.join(bin, 'codex-fixture.mjs'), `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
assert.deepEqual(process.argv.slice(2), ['debug', 'models'])
const home = process.env.CODEX_HOME
assert.notEqual(home, ${JSON.stringify(codexHome)})
assert.deepEqual(fs.readdirSync(home), [])
const log = new URL('invocations.json', import.meta.url)
const entries = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : []
entries.push({ home, args: process.argv.slice(2) })
fs.writeFileSync(log, JSON.stringify(entries))
fs.writeFileSync(path.join(home, 'probe-created-file'), 'remove this isolated probe data')
process.stdout.write(JSON.stringify({ models: [{
  model_messages: { instructions_template: ${JSON.stringify(instructions)}, instructions_variables: {} },
  shell_type: 'shell_command',
  supported_in_api: true,
  slug: 'installed-client-model-not-a-public-model'
}] }))
`)
  const runner = path.join(root, 'run-cli.mjs')
  await fs.writeFile(runner, `
import { main } from ${JSON.stringify(cliUrl)}
globalThis.fetch = () => { throw new Error('The isolated Codex lifecycle must not make network requests.') }
await main(process.argv.slice(2), { models: [
  { id: 'public-model', name: 'Public Model', contextWindow: 1000000, vision: true },
  { id: 'next-model', name: 'Next Model', contextWindow: 200000, vision: false }
] })
`)
  const run = args => {
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.equal((result.stdout + result.stderr).includes(key), false, 'CLI output must not expose the fixture key')
    assert.doesNotMatch(result.stdout, /did not report its own model metadata|generic instructions/)
    return result.stdout
  }
  const assertConfigured = async model => {
    const document = parse(await fs.readFile(config, 'utf8'))
    assert.equal(document.approval_policy, 'never')
    assert.equal(document.model_provider, '1endpoint')
    assert.equal(document.model, model)
    assert.equal(document.model_catalog_json, catalog)
    assert.equal(document.model_providers['1endpoint'].experimental_bearer_token, key)
    const entries = JSON.parse(await fs.readFile(catalog, 'utf8')).models
    assert.deepEqual(entries.map(entry => entry.slug), ['public-model', 'next-model'])
    for (const entry of entries) assert.equal(entry.model_messages.instructions_template, instructions)
    assert.equal(await fs.readFile(auth, 'utf8'), originalAuth)
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, 'codex.json'), 'utf8')).model, model)
  }

  assert.match(run(['setup', '--tool', 'codex', '--route', 'direct', '--model', 'public-model']), /Configured: codex/)
  await assertConfigured('public-model')
  let doctor = run(['doctor', '--tool', 'codex'])
  assert.match(doctor, /Configuration integrity: OK \(codex\)/)
  assert.match(doctor, /Terminal codex detected: yes/)
  assert.match(doctor, /Native setup: applied/)
  assert.match(run(['reconfigure', '--tool', 'codex', '--route', 'direct', '--model', 'next-model']), /Configured: codex/)
  await assertConfigured('next-model')
  doctor = run(['doctor', '--tool', 'codex'])
  assert.match(doctor, /Native setup: applied/)
  assert.match(run(['remove', '--tool', 'codex', '--yes', '--remove-key']), /Removed helper configuration: codex/)
  assert.equal(await fs.readFile(config, 'utf8'), original)
  assert.equal(await fs.readFile(auth, 'utf8'), originalAuth)
  for (const file of [catalog, path.join(stateDir, 'codex.json'), path.join(stateDir, 'codex', 'connection.json'), path.join(stateDir, 'native', 'codex.json')]) {
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
  }
  assert.deepEqual(await fs.readdir(home), [], 'the user home must not receive native or helper state')
  const invocations = JSON.parse(await fs.readFile(path.join(bin, 'invocations.json'), 'utf8'))
  assert.equal(invocations.length, 4, 'setup and reconfigure each probe during preflight and apply')
  assert.equal(new Set(invocations.map(entry => entry.home)).size, 4)
  for (const invocation of invocations) {
    assert.deepEqual(invocation.args, ['debug', 'models'])
    assert.equal(path.dirname(invocation.home), temp)
    assert.match(path.basename(invocation.home), /^coding-helper-codex-catalog-/)
    for (let attempt = 0; attempt < 100 && existsSync(invocation.home); attempt++) await delay(10)
    assert.equal(existsSync(invocation.home), false, 'probe homes must be removed')
  }
  assert.deepEqual(await fs.readdir(temp), [])
})
