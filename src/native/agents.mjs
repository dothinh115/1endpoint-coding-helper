import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import JSON5 from 'json5'
import { snapshot, parseObject, serialize, withNativeLock, commitPair } from './store.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value)
const fixedFields = {
  openclaw: [['models', 'providers', '1endpoint'], ['agents', 'defaults', 'model']],
  hermes: [['providers', '1endpoint'], ...['default', 'model', 'provider', 'base_url', 'api_key', 'key_env', 'api_mode'].map(key => ['model', key])]
}
const fieldId = parts => JSON.stringify(parts)
function checkTool(tool) {
  if (!Object.hasOwn(fixedFields, tool)) throw new Error('Unsupported native agent tool.')
}
export function resolveAgentPath({ tool, env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  checkTool(tool)
  const paths = platform === 'win32' ? path.win32 : path.posix
  const absolute = (value, base = home) => {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Native agent path must be absolute.')
    if (/^~[/\\]/.test(value)) value = paths.join(base, value.slice(2))
    if (!paths.isAbsolute(value) || platform === 'win32' && !/^(?:[a-zA-Z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/.test(value)) throw new Error('Native agent path must be absolute (or start with ~/).')
    return paths.normalize(value)
  }
  absolute(home)
  if (tool === 'hermes') return paths.join(absolute(env.HERMES_HOME || (platform === 'win32' ? paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'hermes') : paths.join(home, '.hermes'))), 'config.yaml')
  const effectiveHome = absolute(env.OPENCLAW_HOME || home)
  if (env.OPENCLAW_CONFIG_READONLY === '1' || env.OPENCLAW_NIX_MODE === '1') throw new Error('OpenClaw configuration is externally managed and read-only.')
  if (env.OPENCLAW_PROFILE && env.OPENCLAW_PROFILE !== 'default' && !env.OPENCLAW_STATE_DIR) throw new Error('Set an explicit OPENCLAW_STATE_DIR for a named OpenClaw profile before setup.')
  return absolute(env.OPENCLAW_CONFIG_PATH || paths.join(absolute(env.OPENCLAW_STATE_DIR || paths.join(effectiveHome, '.openclaw'), effectiveHome), 'openclaw.json'), effectiveHome)
}
function parse(raw, tool) {
  if (raw === null) return {}
  let config
  try { config = tool === 'hermes' ? YAML.parse(raw, { uniqueKeys: true, maxAliasCount: 0 }) : JSON5.parse(raw) }
  catch { throw new Error('Malformed native agent configuration; refusing to change it.') }
  if (!object(config)) throw new Error('Invalid native agent configuration; expected an object.')
  function validate(value) {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', '$include'].includes(key)) throw new Error('Native agent configuration has unsupported include or unsafe mapping keys; edit it separately.')
      validate(child)
    }
  }
  validate(config)
  return config
}
function get(config, parts) {
  let value = config
  for (const key of parts) {
    if (!object(value) || !Object.hasOwn(value, key)) return { present: false }
    value = value[key]
  }
  return { present: true, value }
}
function set(config, parts, entry) {
  let parent = config
  for (const key of parts.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) {
      if (!entry.present) return
      parent[key] = {}
    }
    if (!object(parent[key])) throw new Error('Native agent configuration has an incompatible managed section; edit it separately.')
    parent = parent[key]
  }
  if (entry.present) parent[parts.at(-1)] = entry.value
  else delete parent[parts.at(-1)]
}
function validField(tool, parts) {
  return fixedFields[tool].some(field => equal(parts, field)) || tool === 'openclaw' && Array.isArray(parts) && parts.length === 4 && equal(parts.slice(0, 3), ['agents', 'defaults', 'models']) && parts[3].startsWith('1endpoint/') && validModel(parts[3].slice(10))
}
function validateJournal(saved, tool, target) {
  if (saved.version !== 1 || saved.tool !== tool || saved.path !== target || typeof saved.existed !== 'boolean' || !Array.isArray(saved.fields) || !Array.isArray(saved.created) || saved.fields.length > 256) throw new Error('Invalid native agent journal or target path mismatch.')
  const seen = new Set()
  for (const field of saved.fields) {
    if (!object(field) || !validField(tool, field.path) || seen.has(fieldId(field.path))) throw new Error('Invalid native agent journal fields.')
    seen.add(fieldId(field.path))
    for (const entry of [field.before, field.applied]) if (!object(entry) || typeof entry.present !== 'boolean' || (entry.present ? !Object.hasOwn(entry, 'value') : Object.hasOwn(entry, 'value'))) throw new Error('Invalid native agent journal value.')
  }
  if (!fixedFields[tool].every(field => seen.has(fieldId(field)))) throw new Error('Incomplete native agent journal.')
  for (const parent of saved.created) if (!Array.isArray(parent) || !saved.fields.some(field => parent.length < field.path.length && equal(parent, field.path.slice(0, parent.length)))) throw new Error('Invalid native agent journal containers.')
}
async function load(options, readUnmanaged = true) {
  const target = resolveAgentPath(options)
  const journal = path.resolve(options.stateDir, 'native', `${options.tool}.json`)
  const journalBefore = await snapshot(journal)
  const saved = journalBefore.raw === null ? null : parseObject(journalBefore.raw, 'native agent journal')
  if (saved) validateJournal(saved, options.tool, target)
  if (!saved && !readUnmanaged) return { target, journal, journalBefore, saved }
  const targetBefore = await snapshot(target)
  return { target, journal, journalBefore, saved, targetBefore, config: parse(targetBefore.raw, options.tool) }
}
const drift = data => data.saved.fields.some(field => !equal(get(data.config, field.path), field.applied))
const receipt = (data, extra = {}) => ({ path: data.target, configured: !!data.saved, ...extra })
function clean(config, created) {
  for (const parts of [...created].sort((a, b) => b.length - a.length)) {
    const entry = get(config, parts)
    if (entry.present && object(entry.value) && Object.keys(entry.value).length === 0) set(config, parts, { present: false })
  }
}
export async function applyAgent({ stateDir, tool, model, key, env = process.env, home = os.homedir(), platform = process.platform, dryRun = false }) {
  checkTool(tool)
  if (!validModel(model)) throw new Error('Invalid public agent model ID.')
  if (typeof key !== 'string' || !key.length || key.length > 8192 || /[\s\p{Cc}\p{Cf}]/u.test(key)) throw new Error('A valid API key is required for native agent configuration.')
  const run = async () => {
    const data = await load({ stateDir, tool, env, home, platform })
    if (data.saved && drift(data)) throw new Error('Native agent owned fields were modified; refusing to overwrite drift.')
    const { config, saved } = data
    const desired = new Map()
    const put = (parts, value) => desired.set(fieldId(parts), { path: parts, applied: value === undefined ? { present: false } : { present: true, value } })
    if (tool === 'openclaw') {
      put(['models', 'providers', '1endpoint'], { baseUrl: 'https://1endpoint.dev/api/v1', apiKey: key, api: 'openai-completions', models: [{ id: model, name: model }] })
      const existing = get(config, ['agents', 'defaults', 'model'])
      put(['agents', 'defaults', 'model'], { ...(object(existing.value) ? existing.value : {}), primary: `1endpoint/${model}`, fallbacks: [] })
      put(['agents', 'defaults', 'models', `1endpoint/${model}`], {})
    } else {
      put(['providers', '1endpoint'], { name: '1endpoint', base_url: 'https://1endpoint.dev/api/v1', api_key: key, api_mode: 'chat_completions', default_model: model })
      for (const field of fixedFields.hermes.slice(1)) put(field, ({ default: model, provider: 'custom:1endpoint', api_mode: 'chat_completions' })[field[1]])
    }
    const prior = new Map((saved?.fields || []).map(field => [fieldId(field.path), field]))
    const paths = new Map([...prior.values(), ...desired.values()].map(field => [fieldId(field.path), field.path]))
    const fields = [...paths].map(([id, parts]) => ({ path: parts, before: prior.has(id) ? prior.get(id).before : get(config, parts), applied: desired.get(id)?.applied || prior.get(id).before }))
    if (fields.length > 256) throw new Error('Native agent journal has too many managed model entries; remove before setting up again.')
    const created = new Map((saved?.created || []).map(parts => [fieldId(parts), parts]))
    for (const field of fields) for (let length = 1; length < field.path.length; length++) {
      const parts = field.path.slice(0, length)
      if (!get(config, parts).present) created.set(fieldId(parts), parts)
    }
    for (const field of fields) set(config, field.path, field.applied)
    clean(config, [...created.values()])
    const next = { version: 1, tool, path: data.target, existed: saved ? saved.existed : data.targetBefore.raw !== null, created: [...created.values()], fields }
    const targetRaw = saved && equal(saved.fields, fields) ? data.targetBefore.raw : tool === 'hermes' ? YAML.stringify(config) : serialize(config)
    const journalRaw = serialize(next)
    const changed = targetRaw !== data.targetBefore.raw || journalRaw !== data.journalBefore.raw
    if (!dryRun && changed) await commitPair({ ...data, targetRaw, journalRaw })
    return receipt(data, { configured: !dryRun || !!saved, model, changed: !dryRun && changed, wouldChange: changed, drift: false, dryRun })
  }
  return dryRun ? run() : withNativeLock(stateDir, run)
}
export async function inspectAgent(options) {
  const data = await load(options, false)
  return receipt(data, { drift: data.saved ? drift(data) : false })
}
export async function removeAgent({ dryRun = false, force = false, ...options }) {
  const initial = await load(options, false)
  if (!initial.saved) return receipt(initial, { changed: false, drift: false, dryRun })
  const run = async () => {
    const data = await load(options, false)
    if (!data.saved) return receipt(data, { changed: false, drift: false, dryRun })
    const modified = drift(data)
    if (modified && !force) throw new Error('Native agent owned fields were modified; removal requires explicit force after review.')
    for (const field of data.saved.fields) set(data.config, field.path, field.before)
    clean(data.config, data.saved.created)
    const targetRaw = !data.saved.existed && !Object.keys(data.config).length ? null : options.tool === 'hermes' ? YAML.stringify(data.config) : serialize(data.config)
    if (!dryRun) await commitPair({ ...data, targetRaw, journalRaw: null })
    return receipt(data, { configured: dryRun, changed: !dryRun, wouldChange: true, drift: modified, dryRun })
  }
  return dryRun ? run() : withNativeLock(options.stateDir, run)
}
