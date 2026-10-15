import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import YAML from 'yaml';

const profiles = new Set(['web', 'headless', 'acp', 'sdk']);
const provider = '1endpoint';
const hash = text => crypto.createHash('sha256').update(text ?? '<absent>').digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const valueSame = (a, b) => Boolean(a?.absent) === Boolean(b?.absent) && (a?.absent || same(YAML.parse(a.yaml, { logLevel: 'silent' }), YAML.parse(b.yaml, { logLevel: 'silent' })));

export function resolveDshPaths({ stateDir, env = process.env, home = os.homedir(), platform = process.platform, profile = 'web' } = {}) {
  if (!profiles.has(profile)) throw new Error('Unsupported DSH profile; use web, headless, acp, or sdk');
  if (typeof stateDir !== 'string' || !stateDir || stateDir.includes('\0')) throw new Error('stateDir is required');
  const p = platform === 'win32' ? path.win32 : path.posix;
  let root = env.DSH_HOME || p.join(home, '.dsh');
  if (root === '~') root = home;
  else if (/^~[/\\]/.test(root)) root = p.join(home, root.slice(2));
  root = p.resolve(root);
  return { home: root, profileDir: p.join(root, 'profiles', profile), profilePatch: p.join(root, 'profiles', profile, 'cordis.patch.yml'), homePatch: p.join(root, 'cordis.patch.yml'), envFile: p.join(root, '.env'), credentials: p.join(root, '.credentials.yaml'), journal: p.resolve(stateDir, 'native', 'dsh.json'), lock: p.resolve(stateDir, '.setup.lock') };
}
async function safe(file) {
  let cursor = path.resolve(file);
  while (true) {
    try {
      const s = await fs.lstat(cursor);
      if (s.isSymbolicLink() || (s.isFile() && s.nlink !== 1)) throw new Error('Refusing symbolic or hard linked native DSH path');
      if (cursor === path.resolve(file) && !s.isFile()) throw new Error('Expected regular native DSH file');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
}
async function read(file) { await safe(file); try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function parse(text) {
  const doc = YAML.parseDocument(text || '[]\n', { uniqueKeys: true });
  if (doc.errors.length || !YAML.isSeq(doc.contents)) throw new Error('Invalid DSH patch YAML; expected a patch sequence');
  return doc;
}
function rows(doc) {
  const found = [];
  for (const node of doc.contents.items) {
    if (!YAML.isMap(node)) throw new Error('Invalid DSH patch entry');
    if (node.has('insert')) {
      const inserted = node.get('insert', true);
      if (!YAML.isSeq(inserted)) throw new Error('Unsupported DSH insert operation');
      for (const item of inserted.items) { if (!YAML.isMap(item)) throw new Error('Invalid DSH inserted entry'); found.push({ node: item, seq: inserted }); }
    } else found.push({ node, seq: doc.contents });
  }
  return found;
}
function target(doc, id, create = false) {
  const matches = rows(doc).filter(({ node }) => node.get('id') === id);
  if (matches.some(({ node }) => node.has('remove') || node.has('replace') || node.has('disabled'))) throw new Error('Unsupported or disabled DSH target entry');
  let result = matches.at(-1);
  if (!result && create) {
    const node = doc.createNode({ id, name: `@deepseek-ai/dsh-${id}`, config: {} });
    doc.contents.add(node); result = { node, seq: doc.contents, created: true };
  }
  if (result && result.node.has('config') && !YAML.isMap(result.node.get('config', true))) throw new Error('DSH target config must be a mapping');
  return result;
}
function val(node) { return node === undefined ? { absent: true } : { yaml: YAML.stringify(node) }; }
function at(doc, id, fields) { return target(doc, id)?.node.getIn(['config', ...fields], true); }
function set(doc, id, fields, value) {
  const row = target(doc, id, !value.absent); if (!row) return;
  const keys = ['config', ...fields];
  if (value.absent) row.node.deleteIn(keys);
  else row.node.setIn(keys, YAML.parseDocument(value.yaml).contents);
}
function envValue(text) {
  const matches = (text || '').split(/\r?\n/).filter(line => /^\s*(?:export\s+)?ONEENDPOINT_API_KEY\s*=/.test(line));
  if (matches.length > 1) throw new Error('Duplicate ONEENDPOINT_API_KEY entries in DSH environment');
  return matches[0] ?? null;
}
function envSet(text, line) {
  const old = envValue(text);
  if (old !== null) {
    if (line === null) return (text || '').replace(`${old}\r\n`, '').replace(`${old}\n`, '').replace(old, '');
    return (text || '').replace(old, () => line);
  }
  if (line === null) return text;
  return `${text || ''}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
}
async function credentialPolicy(paths) {
  const text = await read(paths.credentials);
  if (text === null) return { text, doc: null };
  const doc = YAML.parseDocument(text, { uniqueKeys: true, logLevel: 'silent' });
  if (doc.errors.length || (doc.contents !== null && !YAML.isMap(doc.contents))) throw new Error('Invalid DSH managed credential document');
  if (doc.contents && doc.contents.items.length && doc.get('version') !== 1) throw new Error('Unsupported DSH managed credential document version');
  const refs = doc.get('refs', true);
  if (refs && !YAML.isMap(refs)) throw new Error('Invalid DSH managed credential references');
  return { text, doc };
}
async function atomic(file, text) {
  await safe(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await safe(file);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, text, { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function transact(changes) {
  for (const c of changes) if (hash(await read(c.file)) !== hash(c.before)) throw new Error('DSH configuration changed concurrently; retry');
  const done = [];
  try {
    for (const c of changes) {
      if (hash(await read(c.file)) !== hash(c.before)) throw new Error('DSH configuration changed concurrently; retry');
      if (c.after === null) await fs.unlink(c.file); else await atomic(c.file, c.after);
      done.push(c);
    }
  } catch (e) {
    for (const c of done.reverse()) {
      if (c.before === null) await fs.unlink(c.file); else await atomic(c.file, c.before);
    }
    throw e;
  }
}
async function locked(paths, dryRun, fn) {
  if (dryRun) return fn();
  await safe(paths.lock); await fs.mkdir(path.dirname(paths.lock), { recursive: true, mode: 0o700 }); await safe(paths.lock);
  let handle;
  try { handle = await fs.open(paths.lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('Native setup is locked; another setup may be running'); throw e; }
  try { return await fn(); } finally { await handle.close(); await fs.unlink(paths.lock); }
}
function journalParse(text, paths) {
  if (text === null) return null;
  let j; try { j = JSON.parse(text); } catch { throw new Error('Malformed native DSH journal'); }
  if (j.version !== 1 || j.kind !== 'dsh' || j.home !== paths.home || j.profile !== path.basename(paths.profileDir) || !Array.isArray(j.files) || j.files.some(f => ![paths.profilePatch, paths.homePatch, paths.envFile, paths.credentials].includes(f.file))) throw new Error('Invalid native DSH journal or different profile/home; remove the original setup first');
  const seen = new Set();
  const validValue = v => v && typeof v === 'object' && (same(Object.keys(v), ['absent']) && v.absent === true || same(Object.keys(v), ['yaml']) && typeof v.yaml === 'string' && !YAML.parseDocument(v.yaml, { logLevel: 'silent' }).errors.length);
  const allowed = new Set(['llm-pi-ai:providers/1endpoint', 'agent-default-model:provider', 'agent-default-model:model']);
  for (const f of j.files) {
    if (!f || seen.has(f.file) || !(f.original === null || typeof f.original === 'string')) throw new Error('Invalid native DSH journal records');
    seen.add(f.file);
    if (f.file === paths.envFile) {
      if (!(f.envBefore === null || typeof f.envBefore === 'string') || typeof f.envAfter !== 'string' || envValue(f.envAfter) !== f.envAfter || (f.envBefore !== null && envValue(f.envBefore) !== f.envBefore)) throw new Error('Invalid native DSH journal environment record');
    } else if (f.file === paths.credentials) {
      if (!validValue(f.before) || !validValue(f.after) || f.original === null) throw new Error('Invalid native DSH journal credential record');
    } else {
      if (!Array.isArray(f.entries) || !f.entries.length) throw new Error('Invalid native DSH journal entries');
      const entries = new Set();
      for (const e of f.entries) {
        const id = `${e?.id}:${Array.isArray(e?.fields) ? e.fields.join('/') : ''}`;
        if (!allowed.has(id) || entries.has(id) || !validValue(e.before) || !validValue(e.after) || typeof e.created !== 'boolean') throw new Error('Invalid native DSH journal owned field');
        entries.add(id);
      }
    }
  }
  return j;
}
async function savedOptions(options) {
  if (options.profile !== undefined) return options;
  const paths = resolveDshPaths(options);
  const text = await read(paths.journal);
  if (text === null) return options;
  let journal; try { journal = JSON.parse(text); } catch { throw new Error('Malformed native DSH journal'); }
  if (!profiles.has(journal?.profile)) throw new Error('Invalid native DSH journal profile');
  return { ...options, profile: journal.profile };
}
const output = (paths, options, changed, warnings = []) => ({ changed, dryRun: Boolean(options.dryRun), paths, profile: options.profile || 'web', provider, model: options.model, warnings });

export async function applyDsh(options = {}) {
  const paths = resolveDshPaths(options);
  if (typeof options.model !== 'string' || !options.model.trim() || /[\0\r\n]/.test(options.model)) throw new Error('A valid model is required');
  if (typeof options.key !== 'string' || !options.key || options.key.length > 8192 || /[\s\p{Cc}\p{Cf}]/u.test(options.key)) throw new Error('A valid API key is required');
  const inheritedKey = (options.env || process.env).ONEENDPOINT_API_KEY;
  if (inheritedKey && inheritedKey !== options.key) throw new Error('Inherited ONEENDPOINT_API_KEY overrides the native .env key; unset or reconcile it before setup');
  return locked(paths, options.dryRun, async () => {
    const credentials = await credentialPolicy(paths);
    const journalText = await read(paths.journal);
    const previous = journalParse(journalText, paths);
    const docs = new Map();
    for (const file of [paths.profilePatch, paths.homePatch]) { const text = await read(file); docs.set(file, { text, doc: parse(text) }); }
    const files = previous?.files || [];
    const changes = [];
    const stored = credentials.doc?.getIn(['refs', 'ONEENDPOINT_API_KEY'], true);
    let credentialRecord = files.find(f => f.file === paths.credentials);
    if (stored || credentialRecord) {
      const before = val(stored);
      if (credentialRecord && !valueSame(before, credentialRecord.after)) throw new Error('Owned DSH credential reference changed externally');
      if (!credentialRecord) { credentialRecord = { file: paths.credentials, original: credentials.text, before }; files.push(credentialRecord); }
      credentialRecord.after = { yaml: YAML.stringify(options.key) };
      credentials.doc.setIn(['refs', 'ONEENDPOINT_API_KEY'], options.key);
      changes.push({ file: paths.credentials, before: credentials.text, after: String(credentials.doc) });
    }
    const specs = [ ['llm-pi-ai', ['providers', provider], { displayName: '1endpoint', api: 'openai-completions', baseURL: 'https://1endpoint.dev/api/v1', apiKeyEnv: 'ONEENDPOINT_API_KEY', models: [{ id: options.model }] }], ['agent-default-model', ['provider'], provider], ['agent-default-model', ['model'], options.model] ];
    for (const [id, fields, value] of specs) {
      const file = target(docs.get(paths.homePatch).doc, id) ? paths.homePatch : paths.profilePatch;
      const { doc } = docs.get(file);
      let record = files.find(f => f.file === file);
      if (!record) { record = { file, original: docs.get(file).text, entries: [] }; files.push(record); }
      const existing = record.entries.find(e => e.id === id && same(e.fields, fields));
      const before = val(at(doc, id, fields));
      const after = { yaml: YAML.stringify(value) };
      if (existing && !valueSame(before, existing.after)) throw new Error('Owned DSH setting changed externally; remove or reconcile before updating');
      if (existing) existing.after = after;
      else record.entries.push({ id, fields, before, after, created: !target(doc, id) });
      set(doc, id, fields, after);
    }
    for (const [file, { text, doc }] of docs) if (files.some(f => f.file === file)) changes.push({ file, before: text, after: String(doc) });
    const envText = await read(paths.envFile);
    let envRecord = files.find(f => f.file === paths.envFile);
    if (!envRecord) { envRecord = { file: paths.envFile, original: envText, envBefore: envValue(envText) }; files.push(envRecord); }
    else if (envValue(envText) !== envRecord.envAfter) throw new Error('Owned DSH API key changed externally; refusing overwrite');
    envRecord.envAfter = `ONEENDPOINT_API_KEY=${JSON.stringify(options.key)}`;
    changes.push({ file: paths.envFile, before: envText, after: envSet(envText, envRecord.envAfter) });
    changes.push({ file: paths.journal, before: journalText, after: `${JSON.stringify({ version: 1, kind: 'dsh', home: paths.home, profile: options.profile || 'web', files }, null, 2)}\n` });
    const changed = changes.some(c => c.before !== c.after);
    if (!options.dryRun) await transact(changes.filter(c => c.before !== c.after));
    return output(paths, options, changed);
  });
}

export async function removeDsh(options = {}) {
  options = await savedOptions(options);
  const paths = resolveDshPaths(options);
  return locked(paths, options.dryRun, async () => {
    const journalText = await read(paths.journal); const journal = journalParse(journalText, paths);
    if (!journal) return output(paths, options, false);
    const changes = []; const warnings = [];
    for (const record of journal.files) {
      const before = await read(record.file); let after;
      if (record.file === paths.credentials) {
        const { doc } = await credentialPolicy(paths);
        const current = val(doc?.getIn(['refs', 'ONEENDPOINT_API_KEY'], true));
        if (!valueSame(current, record.after) && !options.force) throw new Error('Managed DSH credential drift; recovery journal retained; use force to restore owned fields');
        if (record.before.absent) doc.deleteIn(['refs', 'ONEENDPOINT_API_KEY']);
        else doc.setIn(['refs', 'ONEENDPOINT_API_KEY'], YAML.parseDocument(record.before.yaml).contents);
        const original = YAML.parseDocument(record.original);
        after = same(doc.toJSON(), original.toJSON()) ? record.original : String(doc);
      } else if (record.file === paths.envFile) {
        if (envValue(before) !== record.envAfter && !options.force) throw new Error('Managed DSH API key drift; recovery journal retained; use force to restore owned fields');
        after = envSet(before, record.envBefore);
        if (after === '\n' && record.original === null) after = null;
      } else {
        const doc = parse(before);
        for (const e of record.entries) {
          if (!valueSame(val(at(doc, e.id, e.fields)), e.after) && !options.force) throw new Error('Managed DSH setting drift; recovery journal retained; use force to restore owned fields');
          set(doc, e.id, e.fields, e.before);
        }
        for (const e of record.entries.filter(e => e.created)) {
          const row = target(doc, e.id); if (!row) continue;
          const config = row.node.get('config', true);
          if (YAML.isMap(config?.get('providers', true)) && config.get('providers', true).items.length === 0) config.delete('providers');
          if (YAML.isMap(config) && config.items.length === 0 && row.node.items.every(pair => ['id', 'name', 'config'].includes(String(pair.key)))) row.seq.items.splice(row.seq.items.indexOf(row.node), 1);
        }
        after = String(doc);
        if (same(doc.toJSON(), parse(record.original).toJSON())) after = record.original;
      }
      if (record.original === null && (after === '' || (after !== null && record.file !== paths.envFile && record.file !== paths.credentials && parse(after).contents.items.length === 0))) after = null;
      if (before !== after) changes.push({ file: record.file, before, after });
    }
    changes.push({ file: paths.journal, before: journalText, after: null });
    if (!options.dryRun) await transact(changes);
    return output(paths, options, true, warnings);
  });
}

export async function inspectDsh(options = {}) {
  options = await savedOptions(options);
  const paths = resolveDshPaths(options); const warnings = [];
  const journal = journalParse(await read(paths.journal), paths);
  const docs = [parse(await read(paths.profilePatch)), parse(await read(paths.homePatch))];
  const defaults = target(docs[1], 'agent-default-model')?.node || target(docs[0], 'agent-default-model')?.node;
  let drift = false;
  const credentialState = await credentialPolicy(paths);
  if (journal) for (const record of journal.files) {
    if (record.file === paths.envFile) drift ||= envValue(await read(record.file)) !== record.envAfter;
    else if (record.file === paths.credentials) drift ||= !valueSame(val(credentialState.doc?.getIn(['refs', 'ONEENDPOINT_API_KEY'], true)), record.after);
    else {
      const doc = parse(await read(record.file));
      drift ||= record.entries.some(e => !valueSame(val(at(doc, e.id, e.fields)), e.after));
    }
  }
  return { ...output(paths, options, false, warnings), installed: Boolean(journal), configured: Boolean(journal), drift, provider: defaults?.getIn(['config', 'provider']) || null, model: defaults?.getIn(['config', 'model']) || null, apiKeyConfigured: envValue(await read(paths.envFile)) !== null };
}
