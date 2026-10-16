import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchAgent } from '../src/adapters/agents.mjs'
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', c => stdout += c)
    child.stderr.on('data', c => stderr += c)
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}
for (const tool of ['openclaw', 'hermes']) test(`${tool}: full CLI lifecycle and installation preflight`, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agents-cli-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  const env = { PATH: bin, HOME: root, USERPROFILE: root, ONEENDPOINT_HELPER_HOME: path.join(root, 'state'), OPENCLAW_STATE_DIR: path.join(root, 'openclaw'), HERMES_HOME: path.join(root, 'hermes'), ONEENDPOINT_API_KEY: 'dummy-cli-agent-key' }
  for (const command of ['setup', 'reconfigure', 'run']) {
    const result = await run([command, '--tool', tool, ...(command === 'run' ? [] : ['--model', 'fixture-model'])], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Install it first/)
    await assert.rejects(fs.stat(env.ONEENDPOINT_HELPER_HOME), { code: 'ENOENT' })
  }
  const marker = path.join(root, 'launch.json')
  await fs.writeFile(path.join(bin, tool), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
  for (const [command, extra] of [['setup', ['--model', 'fixture-model']], ['doctor', []], ['backup', []], ['reconfigure', ['--model', 'next-model']], ['run', []]]) {
    const result = await run([command, '--tool', tool, ...extra], env)
    assert.equal(result.code, 0, result.stderr)
    assert.equal((result.stdout + result.stderr).includes(env.ONEENDPOINT_API_KEY), false)
  }
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), tool === 'openclaw' ? ['tui'] : [])
  const backupFiles = await fs.readdir(path.join(env.ONEENDPOINT_HELPER_HOME, 'backups'))
  for (const file of backupFiles) assert.equal((await fs.readFile(path.join(env.ONEENDPOINT_HELPER_HOME, 'backups', file), 'utf8')).includes(env.ONEENDPOINT_API_KEY), false)
  await fs.unlink(path.join(bin, tool))
  const removed = await run(['remove', '--tool', tool, '--yes', '--remove-key'], env)
  assert.equal(removed.code, 0, removed.stderr)
  await assert.rejects(fs.stat(path.join(env.ONEENDPOINT_HELPER_HOME, `${tool}.json`)), { code: 'ENOENT' })
})

test('agent launcher rejects routing and permission override flags', () => {
  for (const tool of ['openclaw', 'hermes']) for (const args of [['--base-url', 'https://invalid.test'], ['--api-key', 'dummy'], ['--yolo'], ['--profile=other'], ['--model', 'other']]) assert.throws(() => launchAgent({ tool, stateDir: '/tmp/fixture', model: 'fixture', args }), /override|directly/)
})
