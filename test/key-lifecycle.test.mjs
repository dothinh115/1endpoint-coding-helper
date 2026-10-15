import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { saveCredential, getCredential } from '../src/credentials.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const fakeKey = 'fixture-key-only-saved-123'
const yamlModule = fileURLToPath(new URL('../node_modules/yaml/dist/index.js', import.meta.url))
function execute(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
    let output = ''
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    child.once('error', reject)
    child.once('close', code => resolve({ code, output }))
  })
}
for (const tool of ['claude', 'dsh']) test(`${tool}: saved key supports doctor/run without environment export and explicit removal`, async t => {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'helper-key-lifecycle-'))
  t.after(async () => { assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('helper-key-lifecycle-')); assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true, force: true }) })
  const stateDir = path.join(root, 'state'), bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  const report = path.join(root, 'launch.json')
  await fs.writeFile(path.join(bin, tool), `#!${process.execPath}\n
const fs = require('node:fs'), path = require('node:path');
const YAML = require(${JSON.stringify(yamlModule)});
const tool = path.basename(process.argv[1]);
let keyPresent, mappingsPresent;
if (tool === 'claude') {
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  keyPresent = settings.env.ANTHROPIC_AUTH_TOKEN === ${JSON.stringify(fakeKey)};
  mappingsPresent = settings.model === 'fixture-model' && settings.env.ANTHROPIC_BASE_URL === 'https://1endpoint.dev/api/v1';
} else {
  const rows = YAML.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8'));
  const provider = rows.find(row => row.id === 'llm-pi-ai').config.providers['1endpoint'];
  keyPresent = fs.readFileSync(path.join(process.env.DSH_HOME, '.env'), 'utf8').includes(JSON.stringify(${JSON.stringify(fakeKey)}));
  mappingsPresent = provider.models[0].id === 'fixture-model' && provider.apiKeyEnv === 'ONEENDPOINT_API_KEY' && rows.find(row => row.id === 'agent-default-model').config.model === 'fixture-model';
}
fs.writeFileSync(process.env.REPORT,JSON.stringify({keyPresent,mappingsPresent,noInjectedKey:!process.env.ONEENDPOINT_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN,argv:process.argv.slice(2)}));\n`, { mode: 0o700 })
  const env = { PATH: bin, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'custom-claude'), DSH_HOME: path.join(root, 'custom-dsh'), ONEENDPOINT_HELPER_HOME: stateDir, REPORT: report }
  // Native setup requires an explicitly supplied user credential, even with no environment export.
  let result = await execute(['setup', '--tool', tool, '--model', 'fixture-model'], env)
  assert.equal(result.code, 1, result.output)
  await saveCredential({ stateDir, tool, key: fakeKey })
  result = await execute(['setup', '--tool', tool, '--model', 'fixture-model'], env)
  assert.equal(result.code, 0, result.output)
  assert.ok(!result.output.includes(fakeKey))
  result = await execute(['doctor', '--tool', tool], env)
  assert.equal(result.code, 0, result.output)
  assert.ok(!result.output.includes(fakeKey))
  result = await execute(['run', '--tool', tool, '--', '--help'], env)
  assert.equal(result.code, 0, result.output)
  const received = JSON.parse(await fs.readFile(report, 'utf8'))
  assert.equal(received.keyPresent, true)
  assert.equal(received.mappingsPresent, true)
  assert.equal(received.noInjectedKey, true)
  assert.deepEqual(received.argv, tool === 'dsh' ? ['--profile', 'web', '--help'] : ['--help'])
  assert.ok(!JSON.stringify(received.argv).includes(fakeKey))
  result = await execute(['remove', '--tool', tool, '--yes'], env)
  assert.equal(result.code, 0, result.output)
  assert.equal((await getCredential({ stateDir, tool, env: {} })).key, fakeKey)
  await assert.rejects(fs.stat(path.join(stateDir, 'native', `${tool}.json`)), { code: 'ENOENT' })
  const nativeFile = tool === 'claude' ? path.join(env.CLAUDE_CONFIG_DIR, 'settings.json') : path.join(env.DSH_HOME, '.env')
  await assert.rejects(fs.stat(nativeFile), { code: 'ENOENT' })
  result = await execute(['remove', '--tool', tool, '--dry-run', '--remove-key'], env)
  assert.equal(result.code, 0, result.output)
  assert.equal((await getCredential({ stateDir, tool, env: {} })).key, fakeKey)
  result = await execute(['remove', '--tool', tool, '--yes', '--remove-key'], env)
  assert.equal(result.code, 0, result.output)
  assert.equal((await getCredential({ stateDir, tool, env: {} })).source, 'missing')
  assert.ok(!result.output.includes(fakeKey))
})
