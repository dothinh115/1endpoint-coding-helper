import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nativeWarnings } from '../src/native/diagnostics.mjs'

test('native diagnostics warn about inherited/project overrides without revealing values', async t => {
  const base = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'helper-diagnostics-'))
  t.after(async () => { assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('helper-diagnostics-')); assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true, force: true }) })
  await fs.mkdir(path.join(root, '.claude'))
  const raw = JSON.stringify({ model: 'secret-model-value', env: { ANTHROPIC_AUTH_TOKEN: 'secret-token-value' }, permissions: { deny: ['Bash(*)'] } })
  await fs.writeFile(path.join(root, '.claude', 'settings.json'), raw)
  const warnings = await nativeWarnings({ tool: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'secret-env-value' }, cwd: root })
  assert.match(warnings.join('\n'), /Inherited routing\/authentication/)
  assert.match(warnings.join('\n'), /Project\/local Claude/)
  assert.doesNotMatch(warnings.join('\n'), /secret-token-value|secret-env-value|secret-model-value/)
  assert.equal(await fs.readFile(path.join(root, '.claude', 'settings.json'), 'utf8'), raw)
})
