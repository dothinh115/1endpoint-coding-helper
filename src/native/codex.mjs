import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parse } from 'smol-toml'
import { snapshot, atomicReplace, withNativeLock } from './store.mjs'

export const PROVIDER_ID = '1endpoint'
export const BASE_URL = 'https://1endpoint.dev/api/v1'
export const CATALOG_FILE = '1endpoint-models.json'
const TABLE = `model_providers.${PROVIDER_ID}`
const TABLE_KEYS = ['name', 'base_url', 'experimental_bearer_token', 'wire_api']
const ROOT_KEYS = ['model_provider', 'model', 'model_catalog_json']
const FIELDS = [...ROOT_KEYS.map(key => ['root', key]), ...TABLE_KEYS.map(key => ['table', key])]
const TEMPLATE_FIELDS = ['model_messages', 'shell_type', 'truncation_policy', 'support_verbosity', 'experimental_supported_tools', 'visibility', 'supported_in_api']
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value)
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\p{Cc}\p{Cf}]/u.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fieldId = (scope, key) => `${scope}.${key}`
const hash = text => createHash('sha256').update(text ?? '').digest('hex')

export function resolveCodexPaths({ stateDir, env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || stateDir.includes('\0')) throw new Error('A helper state directory is required.')
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (typeof home !== 'string' || !paths.isAbsolute(home)) throw new Error('Codex home must be an absolute path.')
  let directory = env.CODEX_HOME
  if (directory === undefined || directory === '') directory = paths.join(home, '.codex')
  else {
    if (typeof directory !== 'string' || directory.includes('\0')) throw new Error('Invalid CODEX_HOME.')
    if (/^~[/\\]/.test(directory)) directory = paths.join(home, directory.slice(2))
    if (!paths.isAbsolute(directory) || (platform === 'win32' && !/^(?:[a-zA-Z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/.test(directory))) throw new Error('CODEX_HOME must be absolute (or start with ~/).')
  }
  const resolved = paths.normalize(directory)
  return {
    home: resolved,
    target: paths.join(resolved, 'config.toml'),
    catalog: paths.join(resolved, CATALOG_FILE),
    journal: path.resolve(stateDir, 'native', 'codex.json'),
  }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}
const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const eolOf = text => text.includes('\r\n') ? '\r\n' : '\n'
const escapeKey = key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const quoted = value => JSON.stringify(value)

function firstHeader(lines) {
  for (let index = 0; index < lines.length; index++) if (/^[ \t]*\[/.test(lines[index])) return index
  return -1
}

/** Reject a managed assignment that spans lines; a partial line edit would corrupt the document. */
function singleLineValue(line) {
  const separator = line.indexOf('=')
  if (separator < 0) return false
  const value = line.slice(separator + 1).trim()
  if ((value.match(/(?:^|[^\\])(?:\\\\)*"/g) || []).length % 2 === 1) return false
  if ((value.startsWith('[') && !value.endsWith(']')) || (value.startsWith('{') && !value.endsWith('}'))) return false
  return true
}

function keyLines(lines, start, end, key) {
  const pattern = new RegExp(`^[ \\t]*${escapeKey(key)}[ \\t]*=`)
  const found = []
  for (let index = start; index < end; index++) if (pattern.test(lines[index])) found.push(index)
  return found
}

function providerHeaders(lines) {
  const pattern = new RegExp(`^[ \\t]*\\[\\s*(?:"model_providers"|model_providers)\\s*\\.\\s*(?:"${PROVIDER_ID}"|${PROVIDER_ID})\\s*\\][ \\t]*(?:#.*)?$`)
  const found = []
  for (let index = 0; index < lines.length; index++) if (pattern.test(lines[index])) found.push(index)
  return found
}

/**
 * Line-level edit that only touches managed keys. Anything ambiguous (duplicate keys, quoted
 * keys, multi-line values) is refused rather than rewritten; the caller re-parses the result and
 * compares it against the intended document before writing.
 */
function editToml(text, rootValues, tableValues) {
  const eol = eolOf(text)
  const lines = text === '' ? [] : text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const headers = providerHeaders(lines)
  let rootEnd = firstHeader(lines)
  if (rootEnd < 0) rootEnd = lines.length
  let tableStart = headers.length ? headers[0] : -1
  let tableEnd = tableStart < 0 ? -1 : (() => { const next = firstHeader(lines.slice(tableStart + 1)); return next < 0 ? lines.length : tableStart + 1 + next })()
  const creating = tableStart < 0

  const write = (scope, key, value) => {
    const start = scope === 'root' ? 0 : tableStart + 1
    const end = scope === 'root' ? rootEnd : tableEnd
    const matches = keyLines(lines, start, end, key)
    if (matches.length === 1) {
      if (!singleLineValue(lines[matches[0]])) throw new Error(`"${key}" spans multiple lines; resolve it before setup.`)
      if (value === null) lines[matches[0]] = null
      else lines[matches[0]] = `${key} = ${quoted(value)}`
      return
    }
    if (value === null) return
    if (scope === 'root') {
      lines.splice(rootEnd, 0, `${key} = ${quoted(value)}`)
      rootEnd++
      return
    }
    let insertAt = tableEnd
    while (insertAt > tableStart + 1 && (lines[insertAt - 1] === null || lines[insertAt - 1].trim() === '')) insertAt--
    lines.splice(insertAt, 0, `${key} = ${quoted(value)}`)
    tableEnd++
  }

  for (const [key, value] of Object.entries(rootValues)) write('root', key, value)
  if (creating) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length) lines.push('')
    lines.push(`[${TABLE}]`)
    for (const [key, value] of Object.entries(tableValues)) if (value !== null) lines.push(`${key} = ${quoted(value)}`)
  } else {
    for (const [key, value] of Object.entries(tableValues)) write('table', key, value)
    const start = providerHeaders(lines)[0]
    const next = firstHeader(lines.slice(start + 1))
    const end = next < 0 ? lines.length : start + 1 + next
    const body = lines.slice(start + 1, end)
    if (body.every(line => line === null || line.trim() === '' || line.trim().startsWith('#'))) lines.splice(start, end - start)
  }
  const kept = lines.filter(line => line !== null)
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  return kept.length ? `${kept.join(eol)}${eol}` : ''
}

function parseDocument(text, label) {
  try { return parse(text) } catch { throw new Error(`Malformed ${label}; refusing to change it.`) }
}

function providerOf(document) {
  return object(document.model_providers?.[PROVIDER_ID]) ? document.model_providers[PROVIDER_ID] : null
}

function readFields(document) {
  const provider = providerOf(document)
  const entry = (container, key) => container && Object.hasOwn(container, key) ? { present: true, value: container[key] } : { present: false }
  return {
    'root.model_provider': entry(document, 'model_provider'),
    'root.model': entry(document, 'model'),
    'root.model_catalog_json': entry(document, 'model_catalog_json'),
    ...Object.fromEntries(TABLE_KEYS.map(key => [`table.${key}`, entry(provider, key)])),
  }
}

function expectedDocument(document, values) {
  const next = structuredClone(document)
  for (const key of ROOT_KEYS) {
    if (values[key] === null) delete next[key]
    else next[key] = values[key]
  }
  const provider = { ...(providerOf(document) || {}) }
  for (const key of TABLE_KEYS) {
    if (values[`table.${key}`] === null) delete provider[key]
    else provider[key] = values[`table.${key}`]
  }
  if (Object.keys(provider).length) next.model_providers = { ...(object(next.model_providers) ? next.model_providers : {}), [PROVIDER_ID]: provider }
  else if (object(next.model_providers)) {
    delete next.model_providers[PROVIDER_ID]
    if (!Object.keys(next.model_providers).length && Object.keys(document.model_providers).length) delete next.model_providers
  }
  return next
}

/** Apply managed values to a document, or throw when the text edit cannot be proven equivalent. */
export function patchCodexToml(text, values, label = 'Codex configuration') {
  const document = parseDocument(text, label)
  const expected = expectedDocument(document, values)
  const rootValues = Object.fromEntries(ROOT_KEYS.map(key => [key, values[key]]))
  const tableValues = Object.fromEntries(TABLE_KEYS.map(key => [key, values[`table.${key}`]]))
  const next = editToml(text, rootValues, tableValues)
  if (!equal(parseDocument(next, label), expected)) throw new Error('Refusing a Codex configuration edit that would change unrelated settings; review the file and retry.')
  return next
}

/**
 * Read the installed Codex client's own catalog as the template for generated entries, so a
 * custom model keeps Codex's instructions and tool contract instead of an invented one.
 */
export function readCatalogTemplate({ codexBin, spawn = spawnSync, timeout = 30000 } = {}) {
  if (typeof codexBin !== 'string' || !codexBin) return null
  const home = path.join(os.tmpdir(), `coding-helper-codex-catalog-${randomUUID()}`)
  try {
    // The client refuses a CODEX_HOME that does not exist, so the isolated home must be created.
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const result = spawn(codexBin, ['debug', 'models'], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CODEX_HOME: home },
    })
    if (!result || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 16 * 1024 * 1024) return null
    const payload = JSON.parse(result.stdout)
    const entry = Array.isArray(payload?.models) ? payload.models.find(model => object(model?.model_messages)) : null
    if (!entry) return null
    const template = Object.fromEntries(TEMPLATE_FIELDS.filter(key => Object.hasOwn(entry, key)).map(key => [key, structuredClone(entry[key])]))
    return Object.keys(template).length ? template : null
  } catch { return null } finally { void fs.rm(home, { recursive: true, force: true }).catch(() => {}) }
}

/**
 * Conservative fallback used only when the installed client cannot report its own catalog. It
 * keeps Codex's documented entry shape so the file still parses, but the instructions are generic
 * and the setup output says so.
 */
export const BUILTIN_TEMPLATE = {
  model_messages: {
    instructions_template: 'You are a coding agent working in the user\'s repository. Follow the user\'s request, use the available tools, and keep the working tree clean.',
    instructions_variables: {},
    approvals: null,
    auto_review: null,
    permissions: null,
  },
  shell_type: 'shell_command',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  support_verbosity: false,
  experimental_supported_tools: [],
  visibility: 'list',
  supported_in_api: true,
}

/** Build the Codex catalog for every enabled text model, using published 1endpoint metadata only. */
export function buildCatalog(models, template) {
  if (!template || !Array.isArray(models)) return null
  const entries = []
  let priority = 1000
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !validModel(model.id)) continue
    if (model.type && model.type !== 'text') continue
    if (model.modelType && model.modelType !== 'text') continue
    const vision = model.vision === true
    const entry = structuredClone(template)
    entry.slug = model.id
    entry.display_name = typeof model.name === 'string' && model.name ? model.name : model.id
    entry.description = typeof model.notes === 'string' && model.notes ? model.notes : `1endpoint model ${model.id}`
    entry.supported_reasoning_levels = []
    entry.priority = priority--
    entry.input_modalities = vision ? ['text', 'image'] : ['text']
    entry.supports_parallel_tool_calls = false
    const context = Number(model.contextWindow)
    if (Number.isSafeInteger(context) && context > 0) {
      entry.context_window = context
      entry.max_context_window = context
    }
    entries.push(entry)
  }
  return entries.length ? `${JSON.stringify({ models: entries }, null, 2)}\n` : null
}

function validateJournal(journal, paths) {
  if (!object(journal) || journal.version !== 1 || journal.tool !== 'codex' || journal.mode !== 'direct') throw new Error('Invalid native Codex journal; remove the previous setup before retrying.')
  if (journal.path !== paths.target || journal.catalogPath !== paths.catalog) throw new Error('Native Codex journal targets a different home; remove the previous setup first.')
  if (typeof journal.existed !== 'boolean' || typeof journal.tableCreated !== 'boolean' || !object(journal.fields)) throw new Error('Invalid native Codex journal.')
  for (const [scope, key] of FIELDS) {
    const pair = journal.fields[fieldId(scope, key)]
    if (!object(pair) || !object(pair.before) || !object(pair.applied)) throw new Error('Invalid native Codex journal fields.')
    for (const entry of [pair.before, pair.applied]) {
      if (typeof entry.present !== 'boolean' || (entry.present ? !Object.hasOwn(entry, 'value') : Object.hasOwn(entry, 'value'))) throw new Error('Invalid native Codex journal value.')
    }
  }
  if (!object(journal.catalog) || typeof journal.catalog.created !== 'boolean' || !(journal.catalog.hash === null || typeof journal.catalog.hash === 'string')) throw new Error('Invalid native Codex catalog record.')
  return journal
}

async function readJournal(paths) {
  const state = await snapshot(paths.journal)
  if (state.raw === null) return { state, journal: null }
  let journal
  try { journal = JSON.parse(state.raw) } catch { throw new Error('Malformed native Codex journal.') }
  return { state, journal: validateJournal(journal, paths) }
}

async function commit(changes) {
  const done = []
  try {
    for (const change of changes) {
      await atomicReplace(change.file, change.after, change.before)
      done.push(change)
    }
  } catch (error) {
    for (const change of done.reverse()) await atomicReplace(change.file, change.before.raw, { hash: hash(change.after), raw: change.after }).catch(() => {})
    throw error
  }
}

export async function applyCodex({ stateDir, model, key, models = [], template = null, dryRun = false, env = process.env, home = os.homedir(), platform = process.platform }) {
  const usedBuiltin = !template
  if (!template) template = BUILTIN_TEMPLATE
  if (!validModel(model)) throw new Error('Invalid public Codex model ID.')
  if (!validKey(key)) throw new Error('A valid API key is required for native Codex configuration.')
  const paths = resolveCodexPaths({ stateDir, env, home, platform })
  const run = async () => {
    const targetBefore = await snapshot(paths.target)
    const catalogBefore = await snapshot(paths.catalog)
    const { state: journalBefore, journal } = await readJournal(paths)
    const document = targetBefore.raw === null ? {} : parseDocument(targetBefore.raw, 'Codex configuration')
    if (catalogBefore.raw !== null && !journal) throw new Error('An unmanaged file already exists at the Codex catalog path; move it before setup.')
    const current = readFields(document)
    if (journal && FIELDS.some(([scope, keyName]) => !equal(current[fieldId(scope, keyName)], journal.fields[fieldId(scope, keyName)].applied))) {
      throw new Error('Native Codex settings were modified outside the helper; review them or force removal before setup.')
    }
    const catalog = buildCatalog(models, template)
    const catalogWanted = catalog !== null || Boolean(journal?.catalog.created)
    const catalogReference = catalog !== null
      ? paths.catalog
      : journal?.fields['root.model_catalog_json'].before.present ? journal.fields['root.model_catalog_json'].before.value : null
    const values = {
      model_provider: PROVIDER_ID,
      model,
      model_catalog_json: catalogReference,
      'table.name': PROVIDER_ID,
      'table.base_url': BASE_URL,
      'table.experimental_bearer_token': key,
      'table.wire_api': 'responses',
    }
    const fields = Object.fromEntries(FIELDS.map(([scope, keyName]) => {
      const id = fieldId(scope, keyName)
      const desired = values[scope === 'root' ? keyName : `table.${keyName}`]
      return [id, { before: journal ? journal.fields[id].before : current[id], applied: desired === null ? { present: false } : { present: true, value: desired } }]
    }))
    const nextText = patchCodexToml(targetBefore.raw ?? '', values)
    const nextCatalog = catalogWanted ? catalog : null
    const nextJournal = {
      version: 1,
      tool: 'codex',
      mode: 'direct',
      path: paths.target,
      catalogPath: paths.catalog,
      existed: journal ? journal.existed : targetBefore.raw !== null,
      tableCreated: journal ? journal.tableCreated : !providerOf(document),
      fields,
      catalog: { created: catalogWanted, hash: nextCatalog === null ? null : hash(nextCatalog) },
    }
    const journalRaw = `${JSON.stringify(nextJournal, null, 2)}\n`
    const catalogChanged = (nextCatalog ?? null) !== (catalogBefore.raw ?? null)
    const targetChanged = nextText !== (targetBefore.raw ?? '')
    const changed = catalogChanged || targetChanged || journalRaw !== journalBefore.raw
    const warnings = []
    if (usedBuiltin) warnings.push('The installed Codex client did not report its own model metadata, so the catalog uses generic instructions. Tool behavior may differ from built-in models.')
    if (catalog === null) warnings.push('No catalog was written because the public model list was empty; Codex will use fallback model metadata.')
    const existingReference = current['root.model_catalog_json']
    if (!journal && existingReference.present && existingReference.value !== paths.catalog) warnings.push('Replaced an existing model_catalog_json reference; removal restores the previous value.')
    if (Object.hasOwn(document, 'model_reasoning_effort')) warnings.push('Your Codex config sets model_reasoning_effort, which is sent for this model too. If requests fail with invalid_reasoning_effort, remove that key or choose a supported effort.')
    if (!dryRun && changed) {
      const changes = []
      if (catalogChanged) changes.push({ file: paths.catalog, before: catalogBefore, after: nextCatalog })
      if (targetChanged) changes.push({ file: paths.target, before: targetBefore, after: nextText })
      changes.push({ file: paths.journal, before: journalBefore, after: journalRaw })
      await commit(changes)
    }
    return { path: paths.target, catalogPath: nextCatalog === null ? null : paths.catalog, journalPath: paths.journal, configured: !dryRun || Boolean(journal), changed: dryRun ? false : changed, wouldChange: changed, dryRun, drift: false, model, warnings }
  }
  return dryRun ? run() : withNativeLock(stateDir, run)
}

export async function inspectCodex({ stateDir, env = process.env, home = os.homedir(), platform = process.platform, dryRun = false }) {
  const paths = resolveCodexPaths({ stateDir, env, home, platform })
  const { journal } = await readJournal(paths)
  if (!journal) return { path: paths.target, catalogPath: paths.catalog, journalPath: paths.journal, configured: false, drift: false, dryRun }
  const target = await snapshot(paths.target)
  const document = target.raw === null ? {} : parseDocument(target.raw, 'Codex configuration')
  const current = readFields(document)
  const driftFields = FIELDS.map(([scope, keyName]) => fieldId(scope, keyName)).filter(id => !equal(current[id], journal.fields[id].applied))
  if (journal.catalog.created) {
    const catalog = await snapshot(paths.catalog)
    if (catalog.hash !== journal.catalog.hash) driftFields.push('catalog')
  }
  return { path: paths.target, catalogPath: paths.catalog, journalPath: paths.journal, configured: true, drift: driftFields.length > 0, driftFields, model: current['root.model'].present ? current['root.model'].value : null, dryRun }
}

export async function removeCodex({ stateDir, env = process.env, home = os.homedir(), platform = process.platform, dryRun = false, force = false }) {
  const paths = resolveCodexPaths({ stateDir, env, home, platform })
  const initial = await readJournal(paths)
  if (!initial.journal) return { path: paths.target, configured: false, changed: false, drift: false, dryRun }
  const run = async () => {
    const { journal, state: journalBefore } = await readJournal(paths)
    const targetBefore = await snapshot(paths.target)
    const catalogBefore = await snapshot(paths.catalog)
    const document = targetBefore.raw === null ? {} : parseDocument(targetBefore.raw, 'Codex configuration')
    const current = readFields(document)
    const drift = FIELDS.some(([scope, keyName]) => !equal(current[fieldId(scope, keyName)], journal.fields[fieldId(scope, keyName)].applied))
      || (journal.catalog.created && catalogBefore.hash !== journal.catalog.hash)
    if (drift && !force) throw new Error('Native Codex settings were modified outside the helper; removal requires explicit force after review.')
    const values = Object.fromEntries(FIELDS.map(([scope, keyName]) => {
      const entry = journal.fields[fieldId(scope, keyName)].before
      return [scope === 'root' ? keyName : `table.${keyName}`, entry.present ? entry.value : null]
    }))
    const nextText = patchCodexToml(targetBefore.raw ?? '', values)
    const nextCatalog = journal.catalog.created ? null : catalogBefore.raw
    if (!dryRun) {
      const changes = []
      if ((nextCatalog ?? null) !== (catalogBefore.raw ?? null)) changes.push({ file: paths.catalog, before: catalogBefore, after: nextCatalog })
      if (nextText !== (targetBefore.raw ?? '')) changes.push({ file: paths.target, before: targetBefore, after: nextText })
      changes.push({ file: paths.journal, before: journalBefore, after: null })
      await commit(changes)
    }
    return { path: paths.target, configured: dryRun, changed: !dryRun, wouldChange: true, drift, dryRun }
  }
  return dryRun ? run() : withNativeLock(stateDir, run)
}
