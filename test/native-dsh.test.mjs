import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { applyDsh, removeDsh, inspectDsh, resolveDshPaths } from '../src/native/dsh.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-dsh-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { home: root, env: {}, stateDir: path.join(root, 'state'), model: 'selected-model', key: 'test-private-key' };
  const paths = resolveDshPaths(options);
  await fs.mkdir(paths.profileDir, { recursive: true });
  return { root, options, paths };
}
async function put(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
function parsed(text) { return YAML.parse(text, { logLevel: 'silent' }); }
const baseline = `# Keep this comment\n- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    extra: true\n    providers:\n      other:\n        api: openai-completions\n        baseURL: https://example.invalid/v1\n        models: [{id: other-model}]\n- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: other\n    model: other-model\n    reasoningEffort: high\n- id: unrelated\n  name: '@example/unrelated'\n  config: {answer: 42}\n`;

test('resolver is pure and uses POSIX and native Windows paths', () => {
  assert.equal(resolveDshPaths({ home: '/users/test', stateDir: '/state', env: {} }).home, '/users/test/.dsh');
  assert.equal(resolveDshPaths({ home: '/users/test', stateDir: '/state', env: { DSH_HOME: '~/custom' } }).home, '/users/test/custom');
  const win = resolveDshPaths({ home: 'C:\\Users\\test', stateDir: 'D:\\state', env: {}, platform: 'win32', profile: 'acp' });
  assert.equal(win.home, 'C:\\Users\\test\\.dsh');
  assert.equal(win.profilePatch, 'C:\\Users\\test\\.dsh\\profiles\\acp\\cordis.patch.yml');
  assert.throws(() => resolveDshPaths({ stateDir: '/s', profile: '../escape' }));
});

test('apply preserves comments, provider lists, names and defaults; updates retain original baseline', async t => {
  const { options, paths } = await fixture(t);
  await put(paths.profilePatch, baseline);
  await put(paths.envFile, '# secret file\nOTHER=untouched\nONEENDPOINT_API_KEY=original\n');
  const result = await applyDsh(options);
  assert.equal(JSON.stringify(result).includes(options.key), false);
  const applied = await fs.readFile(paths.profilePatch, 'utf8');
  assert.match(applied, /# Keep this comment/);
  const entries = parsed(applied);
  assert.equal(entries[0].config.providers.other.models[0].id, 'other-model');
  assert.equal(entries[0].config.extra, true);
  assert.equal(entries[1].config.reasoningEffort, 'high');
  assert.equal(entries[1].name, '@deepseek-ai/dsh-agent-default-model');
  assert.equal(entries[1].config.model, options.model);
  assert.equal((await fs.stat(paths.journal)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(paths.envFile)).mode & 0o777, 0o600);
  await applyDsh({ ...options, model: 'next-model', key: 'new-private-key' });
  assert.equal((await inspectDsh(options)).model, 'next-model');
  await removeDsh(options);
  assert.equal(await fs.readFile(paths.profilePatch, 'utf8'), baseline);
  assert.equal(await fs.readFile(paths.envFile, 'utf8'), '# secret file\nOTHER=untouched\nONEENDPOINT_API_KEY=original\n');
});

test('home patch overrides are updated effectively and removal preserves unrelated edits', async t => {
  const { options, paths } = await fixture(t);
  await put(paths.homePatch, baseline);
  await applyDsh(options);
  await assert.rejects(fs.access(paths.profilePatch), { code: 'ENOENT' });
  const doc = YAML.parseDocument(await fs.readFile(paths.homePatch, 'utf8'));
  doc.contents.items[1].setIn(['config', 'reasoningEffort'], 'low');
  await put(paths.homePatch, String(doc));
  await removeDsh(options);
  const restored = parsed(await fs.readFile(paths.homePatch, 'utf8'));
  assert.equal(restored[1].config.model, 'other-model');
  assert.equal(restored[1].config.reasoningEffort, 'low');
  assert.equal(restored[0].config.providers['1endpoint'], undefined);
});

test('fresh setup/remove, dry run and missing journal are safe', async t => {
  const { options, paths } = await fixture(t);
  assert.equal((await removeDsh(options)).changed, false);
  await applyDsh({ ...options, dryRun: true });
  await assert.rejects(fs.access(paths.journal), { code: 'ENOENT' });
  await assert.rejects(fs.access(paths.envFile), { code: 'ENOENT' });
  await applyDsh(options);
  await removeDsh(options);
  await assert.rejects(fs.access(paths.profilePatch), { code: 'ENOENT' });
  await assert.rejects(fs.access(paths.envFile), { code: 'ENOENT' });
});

test('malformed config, credential precedence, links and setup lock fail closed', async t => {
  const { options, paths, root } = await fixture(t);
  await put(paths.profilePatch, '- id: [broken\n');
  await assert.rejects(applyDsh(options), /Invalid DSH/);
  await put(paths.profilePatch, '[]\n');
  await put(paths.credentials, 'never-read-this-secret');
  await assert.rejects(applyDsh(options), /credential document/);
  await assert.rejects(inspectDsh(options), /credential document/);
  await fs.unlink(paths.credentials);
  await put(path.join(root, 'linked'), '[]\n');
  await fs.unlink(paths.profilePatch);
  await fs.symlink(path.join(root, 'linked'), paths.profilePatch);
  await assert.rejects(applyDsh(options), /linked/);
  await fs.unlink(paths.profilePatch);
  await fs.link(path.join(root, 'linked'), paths.profilePatch);
  await assert.rejects(applyDsh(options), /linked/);
  await fs.unlink(paths.profilePatch);
  await put(paths.lock, '');
  await assert.rejects(applyDsh(options), /locked/);
});

test('drift retains recovery journal and force restores only owned fields', async t => {
  const { options, paths } = await fixture(t);
  await applyDsh(options);
  const doc = YAML.parseDocument(await fs.readFile(paths.profilePatch, 'utf8'));
  doc.contents.items[1].setIn(['config', 'model'], 'user-edit');
  doc.contents.items[1].setIn(['config', 'reasoningEffort'], 'high');
  await put(paths.profilePatch, String(doc));
  const before = await fs.readFile(paths.profilePatch, 'utf8');
  await assert.rejects(applyDsh(options), /changed externally/);
  assert.equal((await inspectDsh(options)).drift, true);
  await assert.rejects(removeDsh(options), /drift/);
  await fs.access(paths.journal);
  assert.equal(await fs.readFile(paths.profilePatch, 'utf8'), before);
  await removeDsh({ ...options, force: true });
  const remaining = parsed(await fs.readFile(paths.profilePatch, 'utf8'));
  assert.equal(remaining[0].config.model, undefined);
  assert.equal(remaining[0].config.reasoningEffort, 'high');
});

test('saved non-web profile is discovered and malformed owned journal fields fail closed', async t => {
  const { options } = await fixture(t);
  const paths = resolveDshPaths({ ...options, profile: 'headless' });
  await applyDsh({ ...options, profile: 'headless' });
  assert.equal((await inspectDsh(options)).profile, 'headless');
  const original = await fs.readFile(paths.journal, 'utf8');
  const bad = JSON.parse(original);
  bad.files.find(f => f.entries).entries[0].fields = ['__proto__', 'evil'];
  await put(paths.journal, JSON.stringify(bad));
  await assert.rejects(removeDsh(options), /journal owned field/);
  await put(paths.journal, original);
  await removeDsh(options);
  await assert.rejects(fs.access(paths.profilePatch), { code: 'ENOENT' });
});

test('managed credential override updates only its reference and restores baseline through updates', async t => {
  const { options, paths } = await fixture(t);
  const original = '# credentials stay private\nversion: 1\nrefs:\n  OTHER_KEY: other-private\n  ONEENDPOINT_API_KEY: original-private\nrecords:\n  llm-pi-ai/other:\n    kind: api-key\n    key: record-private\n';
  await put(paths.credentials, original);
  await applyDsh(options);
  let store = parsed(await fs.readFile(paths.credentials, 'utf8'));
  assert.equal(store.refs.ONEENDPOINT_API_KEY, options.key);
  assert.equal(store.refs.OTHER_KEY, 'other-private');
  assert.equal(store.records['llm-pi-ai/other'].key, 'record-private');
  const inspection = JSON.stringify(await inspectDsh(options));
  for (const secret of [options.key, 'other-private', 'original-private', 'record-private']) assert.equal(inspection.includes(secret), false);
  await applyDsh({ ...options, key: 'replacement-private' });
  await removeDsh(options);
  assert.equal(await fs.readFile(paths.credentials, 'utf8'), original);
});

test('target or journal write failure atomically rolls back all completed changes', async t => {
  const { options, paths } = await fixture(t);
  await put(paths.profilePatch, baseline);
  await put(paths.envFile, 'OTHER=unchanged\n');
  const originalRename = fs.rename;
  for (const failTarget of [paths.envFile, paths.journal]) {
    let failed = false;
    fs.rename = async (source, destination) => {
      if (destination === failTarget && !failed) { failed = true; throw new Error('injected atomic write failure'); }
      return originalRename(source, destination);
    };
    try { await assert.rejects(applyDsh(options), /injected atomic write failure/); }
    finally { fs.rename = originalRename; }
    assert.equal(await fs.readFile(paths.profilePatch, 'utf8'), baseline);
    assert.equal(await fs.readFile(paths.envFile, 'utf8'), 'OTHER=unchanged\n');
    await assert.rejects(fs.access(paths.journal), { code: 'ENOENT' });
    await assert.rejects(fs.access(paths.lock), { code: 'ENOENT' });
  }
});

test('installed native dsh --dump-config composes BEFORE/AFTER without any provider request', async t => {
  const available = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return t.skip('DSH executable not installed');
  assert.equal(available.status, 0, available.stderr);
  const { options, paths } = await fixture(t);
  const dump = () => {
    const result = spawnSync('dsh', ['--profile', 'web', '--dump-config'], { encoding: 'utf8', env: { ...process.env, HOME: options.home, DSH_HOME: paths.home } });
    assert.equal(result.status, 0, result.stderr);
    return parsed(result.stdout);
  };
  const before = dump();
  await put(paths.profilePatch, baseline.replace(/- id: unrelated[\s\S]*$/, ''));
  const original = await fs.readFile(paths.profilePatch, 'utf8');
  await applyDsh(options);
  const after = dump();
  const flattened = JSON.stringify(after);
  assert.match(flattened, /selected-model/);
  assert.match(flattened, /other-model/);
  assert.match(flattened, /reasoningEffort/);
  assert.doesNotMatch(flattened, /test-private-key/);
  assert.ok(before);
  const effectiveRows = after.flatMap(row => row.insert || [row]);
  assert.equal(effectiveRows.find(row => row.id === 'agent-default-model').config.model, options.model);
  assert.equal(effectiveRows.find(row => row.id === 'llm-pi-ai').config.providers['1endpoint'].apiKeyEnv, 'ONEENDPOINT_API_KEY');
  await removeDsh(options);
  assert.equal(await fs.readFile(paths.profilePatch, 'utf8'), original);
  assert.doesNotMatch(JSON.stringify(dump()), /selected-model/);
});
