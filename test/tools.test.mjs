import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findExecutable, TOOL_INFO } from '../src/tools.mjs'

async function fixture(t) {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'coding-helper-tools-'))
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    assert.ok(path.basename(root).startsWith('coding-helper-tools-'))
    assert.equal(await fs.realpath(root), root)
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

test('tool metadata uses full names and official installation pages', () => {
  assert.deepEqual(TOOL_INFO.dsh, { name: 'DeepSeek Harness (DSH)', command: 'dsh', installUrl: 'https://github.com/deepseek-ai/deepseek-harness' })
  assert.deepEqual(TOOL_INFO.claude, { name: 'Claude Code', command: 'claude', installUrl: 'https://code.claude.com/docs/en/overview' })
})

test('executable checks handle missing PATH, directories and missing commands', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'dsh'))
  assert.equal(await findExecutable('dsh', {}), null)
  assert.equal(await findExecutable('dsh', { PATH: root }), null)
  assert.equal(await findExecutable('claude', { PATH: root }), null)
})

test('executable lookup respects PATH order without running the tool', async t => {
  const root = await fixture(t)
  const first = path.join(root, 'first'), second = path.join(root, 'second with spaces')
  await fs.mkdir(first)
  await fs.mkdir(second)
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  for (const directory of [first, second]) await fs.writeFile(path.join(directory, 'dsh' + suffix), 'not executable program content', { mode: 0o700 })
  assert.equal(await findExecutable('dsh', { PATH: [first, second].join(path.delimiter) }), path.join(first, 'dsh' + suffix))
  assert.equal(await findExecutable('dsh', { PATH: second }), path.join(second, 'dsh' + suffix))
})

test('non-executable files do not count as installed on POSIX', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'claude'), 'not executable', { mode: 0o600 })
  assert.equal(await findExecutable('claude', { PATH: root }), null)
})
