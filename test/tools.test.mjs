import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findExecutable, findCodex, TOOL_INFO, missingToolMessage } from '../src/tools.mjs'

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

test('package description stays generic as tool support expands', async () => {
  const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(metadata.description, 'Native 1endpoint setup for coding tools and agents')
  assert.equal(metadata.files.includes('docs'), false)
})

test('Codex detection finds the Desktop app bundle as well as the terminal executable', async t => {
  const root = await fixture(t)
  const home = path.join(root, 'home')
  const bundle = path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin')
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  assert.deepEqual(await findCodex({ env: { PATH: bin }, home, platform: 'darwin', applicationRoots: [path.join(home, 'Applications')] }), { command: null, surface: null, terminal: null })

  const terminal = path.join(bin, 'codex')
  await fs.writeFile(terminal, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  assert.deepEqual(await findCodex({ env: { PATH: bin }, home, platform: 'darwin', applicationRoots: [path.join(home, 'Applications')] }), { command: terminal, surface: 'terminal', terminal })

  await fs.mkdir(bundle, { recursive: true })
  const desktop = path.join(bundle, 'codex')
  await fs.writeFile(desktop, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  // The Desktop bundle wins because it is the client that reads the generated catalog.
  assert.deepEqual(await findCodex({ env: { PATH: bin }, home, platform: 'darwin', applicationRoots: [path.join(home, 'Applications')] }), { command: desktop, surface: 'desktop', terminal })
  // Without the terminal executable a Desktop-only installation is still supported.
  assert.deepEqual(await findCodex({ env: { PATH: path.join(root, 'empty') }, home, platform: 'darwin', applicationRoots: [path.join(home, 'Applications')] }), { command: desktop, surface: 'desktop', terminal: null })
  // Other platforms rely on the terminal executable only.
  assert.deepEqual(await findCodex({ env: { PATH: bin }, home, platform: 'linux', applicationRoots: [path.join(home, 'Applications')] }), { command: terminal, surface: 'terminal', terminal })
})

test('missing Codex guidance names both installation surfaces', () => {
  assert.match(missingToolMessage('codex', 'en'), /Codex Desktop app was found in \/Applications/)
  assert.match(missingToolMessage('codex', 'en'), /Install Codex Desktop or the Codex CLI/)
  assert.match(missingToolMessage('codex', 'vi'), /Cài Codex Desktop hoặc Codex CLI trước/)
  assert.match(missingToolMessage('dsh', 'en'), /not on PATH/)
})
