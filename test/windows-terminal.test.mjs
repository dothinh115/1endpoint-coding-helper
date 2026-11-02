import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const modulePath = process.env.CODING_HELPER_TEST_NODE_PTY
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const probe = fileURLToPath(new URL('../test-support/windows-terminal-probe.cjs', import.meta.url))

for (const action of ['Exit', 'Escape']) {
  test(`Windows real console returns after ${action}`, { skip: process.platform !== 'win32' || !modulePath, timeout: 15000 }, async t => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'helper-terminal-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(HOME|USERPROFILE|ONEENDPOINT_HELPER_HOME|ONEENDPOINT_API_KEY)$/i.test(key)) delete env[key]
    Object.assign(env, { HOME: root, USERPROFILE: root, ONEENDPOINT_HELPER_HOME: path.join(root, 'state'), NO_COLOR: '1' })
    const result = spawnSync(process.execPath, [probe, modulePath, cli, action, root], { env, cwd: root, encoding: 'utf8', timeout: 13000, windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const receipt = JSON.parse(result.stdout.trim())
    assert.equal(receipt.passed, true)
    assert.equal(receipt.exitCode, 0)
    await assert.rejects(fs.stat(env.ONEENDPOINT_HELPER_HOME), { code: 'ENOENT' })
  })
}
