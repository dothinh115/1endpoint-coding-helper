import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, isAbsolute, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createDshPlan } from '../src/adapters/dsh.mjs';

const model = 'openai/gpt-5';

test('plan uses an absolute isolated home and exact provider/default-model patches', () => {
  const plan = createDshPlan({ stateDir: './state', model });
  const overlay = resolve('state/dsh/1endpoint.patch.yml');
  assert.deepEqual(plan.args, ['--profile', 'web', '--patch', overlay]);
  assert.equal(plan.command, 'dsh');
  assert.deepEqual(plan.env, { DSH_HOME: resolve('state/dsh/home') });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, overlay);
  assert.ok(isAbsolute(plan.files[0].path));
  assert.deepEqual(JSON.parse(plan.files[0].content), [
    {
      id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { '1endpoint': {
        displayName: '1endpoint', api: 'openai-completions',
        baseURL: 'https://1endpoint.dev/api/v1', apiKeyEnv: 'ONEENDPOINT_API_KEY',
        models: [{ id: model }],
      } } },
    },
    {
      id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: '1endpoint', model },
    },
  ]);
  assert.match(plan.hints.join(' '), /isolated.*not read or merged/i);
  assert.match(plan.hints.join(' '), /replace the entire entry config/);
  assert.equal(JSON.stringify(plan).includes('apiKey"'), false);
});

test('JSON-as-YAML round trips special model identifiers without injection', () => {
  const special = 'vendor/model: "quoted"\n- id: injected\n\\path\t雪 # ! & *';
  const plan = createDshPlan({ stateDir: './state with spaces', model: special });
  const patches = JSON.parse(plan.files[0].content);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0].config.providers['1endpoint'].models, [{ id: special }]);
  assert.equal(patches[1].config.model, special);
});



test('invalid inputs fail before producing a configuration plan', () => {
  for (const stateDir of [undefined, '', '  ', 42, 'a\0b']) {
    assert.throws(() => createDshPlan({ stateDir, model }), /stateDir/);
  }
  for (const invalidModel of [undefined, '', '\t', 42, 'a\0b']) {
    assert.throws(() => createDshPlan({ stateDir: './state', model: invalidModel }), /model/);
  }
  for (const profile of ['sdk-minimal', 'tui', 'desktop', '../web', '', null]) {
    assert.throws(() => createDshPlan({ stateDir: './state', model, profile }), /Unsupported DSH profile/);
  }
  assert.equal(createDshPlan({ stateDir: './state', model, profile: 'headless' }).args[1], 'headless');
});

const installedDsh = '/opt/homebrew/bin/dsh';

test('installed isolated DSH composes provider/default model and headless schema without requests', async (t) => {
  try { await access(installedDsh); } catch {
    t.skip(`Installed DSH not found at ${installedDsh}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'coding-helper-dsh-test-'));
  t.after(async () => {
    // Only remove the exact temporary directory we created, never an arbitrary path.
    const parent = resolve(tmpdir());
    const child = relative(parent, resolve(root));
    assert.ok(child.startsWith('coding-helper-dsh-test-') && !child.includes(sep));
    assert.equal(dirname(resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  const special = 'vendor/model: "quoted"\\雪';
  const plan = createDshPlan({ stateDir: root, model: special });
  await mkdir(plan.env.DSH_HOME, { recursive: true });
  await mkdir(dirname(plan.files[0].path), { recursive: true });
  await writeFile(plan.files[0].path, plan.files[0].content);
  // Explicit environment whitelist: no live credentials or user DSH config inputs.
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: tmpdir(),
    NO_COLOR: '1',
    ...plan.env,
  };
  const version = spawnSync(installedDsh, ['--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.2\.1-alpha\.3/);
  const dump = spawnSync(installedDsh, [...plan.args, '--dump-config'], {
    env, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
  });
  assert.ifError(dump.error);
  assert.equal(dump.status, 0, dump.stderr);
  // Parse using DSH's own installed YAML parser (not a package dependency).
  const requireDsh = createRequire('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json');
  const YAML = requireDsh('yaml');
  const tree = YAML.parse(dump.stdout, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] });
  assert.ok(Array.isArray(tree), 'DSH dump must be an entry array');
  const provider = tree.find((entry) => entry.id === 'llm-pi-ai');
  const defaultModel = tree.find((entry) => entry.id === 'agent-default-model');
  const patches = JSON.parse(plan.files[0].content);
  assert.deepEqual(provider.config, patches[0].config);
  assert.deepEqual(defaultModel.config, patches[1].config);
  assert.equal(provider.name, patches[0].name);
  assert.equal(defaultModel.name, patches[1].name);
  const schemaPlan = createDshPlan({ stateDir: root, model: special, profile: 'headless' });
  const schema = spawnSync(installedDsh, [...schemaPlan.args, '--dump-config-schema'], {
    env, encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024,
  });
  assert.ifError(schema.error);
  assert.equal(schema.status, 0, schema.stderr);
  const parsedSchema = JSON.parse(schema.stdout);
  assert.equal(typeof parsedSchema, 'object');
  assert.ok(JSON.stringify(parsedSchema).includes('apiKeyEnv'));
});
