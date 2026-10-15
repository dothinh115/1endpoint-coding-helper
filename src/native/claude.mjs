import os from 'node:os'
import path from 'node:path'
import { snapshot, parseObject, serialize, withNativeLock, commitPair } from './store.mjs'

const MODEL_ENV = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
export const CONFLICTING_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_AUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS']
const ENV_FIELDS = [...MODEL_ENV, 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...CONFLICTING_ENV]
const FIELDS = ['model', 'apiKeyHelper', ...ENV_FIELDS.map(key => `env.${key}`)]
const own = (object, key) => Object.hasOwn(object, key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value)

/** Pure resolution: overrides must be absolute, except the explicitly supported ~/ form. */
export function resolveClaudePath({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (typeof home !== 'string' || !paths.isAbsolute(home) || home.includes('\0')) throw new Error('Claude home must be an absolute path.')
  let directory = env.CLAUDE_CONFIG_DIR
  if (directory === undefined || directory === '') directory = paths.join(home, '.claude')
  else {
    if (typeof directory !== 'string' || directory.includes('\0')) throw new Error('Invalid CLAUDE_CONFIG_DIR.')
    if (/^~[/\\]/.test(directory)) directory = paths.join(home, directory.slice(2))
    if (!paths.isAbsolute(directory) || (platform === 'win32' && !/^(?:[a-zA-Z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/.test(directory))) throw new Error('CLAUDE_CONFIG_DIR must be absolute (or start with ~/).')
  }
  return paths.join(paths.normalize(directory), 'settings.json')
}
function locations(options) {
  if (typeof options.stateDir !== 'string' || !options.stateDir) throw new Error('A helper state directory is required.')
  return { target: resolveClaudePath(options), journal: path.resolve(options.stateDir, 'native', 'claude.json') }
}
function fieldValue(settings, field) {
  const container = field.startsWith('env.') ? settings.env : settings
  const key = field.startsWith('env.') ? field.slice(4) : field
  return object(container) && own(container, key) ? { present: true, value: container[key] } : { present: false }
}
function setField(settings, field, entry) {
  const inEnv = field.startsWith('env.')
  const key = inEnv ? field.slice(4) : field
  if (inEnv && !own(settings, 'env')) {
    if (!entry.present) return
    settings.env = {}
  }
  const container = inEnv ? settings.env : settings
  if (entry.present) Object.defineProperty(container, key, { value: entry.value, enumerable: true, configurable: true, writable: true })
  else delete container[key]
}
function validateSettings(settings) {
  if (own(settings, 'env') && !object(settings.env)) throw new Error('Claude settings env must be an object; refusing to change it.')
}
function validateJournal(journal, target) {
  if (journal.version !== 1 || journal.tool !== 'claude' || journal.path !== target || typeof journal.existed !== 'boolean' || typeof journal.envExisted !== 'boolean' || !object(journal.fields) || Object.keys(journal.fields).length !== FIELDS.length || !FIELDS.every(field => own(journal.fields, field))) throw new Error('Invalid native journal or target path mismatch; refusing to change configuration.')
  for (const field of FIELDS) {
    const pair = journal.fields[field]
    if (!object(pair) || !object(pair.before) || !object(pair.applied)) throw new Error('Invalid native journal fields.')
    for (const entry of [pair.before, pair.applied]) {
      if (typeof entry.present !== 'boolean' || (entry.present ? !own(entry, 'value') : own(entry, 'value'))) throw new Error('Invalid native journal value.')
    }
  }
}
async function load(options, { readUnmanaged = true } = {}) {
  const { target, journal } = locations(options)
  const journalBefore = await snapshot(journal)
  const saved = journalBefore.raw === null ? null : parseObject(journalBefore.raw, 'native journal')
  if (saved) validateJournal(saved, target)
  // Missing journal removal/inspection never even reads an unmanaged settings file.
  if (!saved && !readUnmanaged) return { target, journal, journalBefore, saved }
  const targetBefore = await snapshot(target)
  const settings = targetBefore.raw === null ? {} : parseObject(targetBefore.raw, 'Claude settings')
  validateSettings(settings)
  return { target, journal, journalBefore, targetBefore, settings, saved }
}
function driftFields(settings, saved) {
  return FIELDS.filter(field => !equal(fieldValue(settings, field), saved.fields[field].applied))
}
function receipt(data, extra = {}) {
  return { configured: !!data.saved, path: data.target, journalPath: data.journal, ...extra }
}
function desiredFields(model, roles, key) {
  if (!validModel(model)) throw new Error('Invalid public Claude model ID.')
  if (roles !== undefined && (!object(roles) || Object.keys(roles).some(role => !['haiku', 'sonnet', 'opus', 'fable'].includes(role)) || Object.values(roles).some(value => !validModel(value)))) throw new Error('Invalid Claude model role mapping.')
  if (typeof key !== 'string' || !key.length || key.length > 8192 || /[\s\p{Cc}\p{Cf}]/u.test(key)) throw new Error('A valid API key is required for native Claude configuration.')
  const sonnet = roles?.sonnet || model
  const values = {
    model: sonnet,
    'env.ANTHROPIC_MODEL': sonnet,
    'env.ANTHROPIC_DEFAULT_HAIKU_MODEL': roles?.haiku || model,
    'env.ANTHROPIC_DEFAULT_SONNET_MODEL': sonnet,
    'env.ANTHROPIC_DEFAULT_OPUS_MODEL': roles?.opus || model,
    'env.ANTHROPIC_DEFAULT_FABLE_MODEL': roles?.fable || roles?.opus || model,
    'env.CLAUDE_CODE_SUBAGENT_MODEL': sonnet,
    'env.ANTHROPIC_BASE_URL': 'https://1endpoint.dev/api/v1',
    'env.ANTHROPIC_AUTH_TOKEN': key,
  }
  return Object.fromEntries(FIELDS.map(field => [field, own(values, field) ? { present: true, value: values[field] } : { present: false }]))
}

/** Writes only native settings and its private per-field recovery journal. Not a transaction with legacy helper state. */
export async function applyClaude({ stateDir, model, roles, key, env = process.env, home = os.homedir(), platform = process.platform, dryRun = false }) {
  const options = { stateDir, env, home, platform }
  const desired = desiredFields(model, roles, key)
  const run = async () => {
    const data = await load(options)
    const { settings, saved, targetBefore, journalBefore, target, journal } = data
    if (saved && driftFields(settings, saved).length) throw new Error('Native Claude owned fields were modified; refusing to overwrite drift. Review or explicitly force removal first.')
    const fields = Object.fromEntries(FIELDS.map(field => [field, { before: saved ? saved.fields[field].before : fieldValue(settings, field), applied: desired[field] }]))
    const nextJournal = { version: 1, tool: 'claude', path: target, existed: saved ? saved.existed : targetBefore.raw !== null, envExisted: saved ? saved.envExisted : own(settings, 'env'), fields }
    for (const field of FIELDS) setField(settings, field, desired[field])
    const targetRaw = saved && FIELDS.every(field => equal(saved.fields[field].applied, desired[field])) ? targetBefore.raw : serialize(settings)
    const journalRaw = serialize(nextJournal)
    const changed = targetRaw !== targetBefore.raw || journalRaw !== journalBefore.raw
    if (!dryRun && changed) await commitPair({ target, targetBefore, targetRaw, journal, journalBefore, journalRaw })
    return receipt(data, { configured: !dryRun || !!saved, changed: dryRun ? false : changed, wouldChange: changed, dryRun, drift: false, model: desired.model.value })
  }
  return dryRun ? run() : withNativeLock(stateDir, run)
}
export async function inspectClaude({ stateDir, env = process.env, home = os.homedir(), platform = process.platform, dryRun = false }) {
  const data = await load({ stateDir, env, home, platform }, { readUnmanaged: false })
  if (!data.saved) return receipt(data, { drift: false, dryRun })
  const fields = driftFields(data.settings, data.saved)
  return receipt(data, { drift: fields.length > 0, driftFields: fields, dryRun })
}
export async function removeClaude({ stateDir, env = process.env, home = os.homedir(), platform = process.platform, dryRun = false, force = false }) {
  const options = { stateDir, env, home, platform }
  const run = async () => {
    const data = await load(options, { readUnmanaged: false })
    if (!data.saved) return receipt(data, { changed: false, dryRun, drift: false })
    const { saved, settings, target, journal, targetBefore, journalBefore } = data
    const drift = driftFields(settings, saved).length > 0
    if (drift && !force) throw new Error('Native Claude owned fields were modified; removal requires explicit force after review.')
    for (const field of FIELDS) setField(settings, field, saved.fields[field].before)
    if (!saved.envExisted && object(settings.env) && !Object.keys(settings.env).length) delete settings.env
    const targetRaw = !saved.existed && !Object.keys(settings).length ? null : serialize(settings)
    if (!dryRun) await commitPair({ target, targetBefore, targetRaw, journal, journalBefore, journalRaw: null })
    return receipt(data, { configured: dryRun, changed: !dryRun, wouldChange: true, dryRun, drift })
  }
  // Missing journals must not create a state directory or lock.
  const initial = await load(options, { readUnmanaged: false })
  if (!initial.saved) return receipt(initial, { changed: false, dryRun, drift: false })
  return dryRun ? run() : withNativeLock(stateDir, run)
}
