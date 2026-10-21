import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import spawn from 'cross-spawn'
import { snapshot, atomicReplace, withNativeLock } from './store.mjs'
import { BASE_URL } from './codex.mjs'

const PROVIDER = '1endpoint'
const MAX_BYTES = 8 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value)
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\p{Cc}\p{Cf}]/u.test(value)

/** Spawn the user's installed OpenCodex CLI; secrets travel only through stdin. */
export function opencodexRunner({ ocxBin, env = process.env, timeout = 60000 } = {}) {
  return ({ args, input }) => new Promise((resolve, reject) => {
    let child
    try { child = spawn(ocxBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env, shell: false, windowsHide: true }) }
    catch { reject(new Error('Could not start the OpenCodex CLI.')); return }
    let stdout = '', stderr = '', size = 0, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(new Error('OpenCodex command timed out.'))
    }, timeout)
    child.once('error', () => finish(new Error('Could not start the OpenCodex CLI.')))
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BYTES) { try { child.kill() } catch {}; finish(new Error('OpenCodex command returned too much output.')); return }
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8') })
    child.once('close', code => finish(null, { code: code ?? 1, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function requireOk(result, label) {
  if (!result || result.code !== 0) {
    const detail = String(result?.stderr || '').split('\n').find(line => /error/i.test(line))
    throw new Error(`OpenCodex ${label} failed${detail ? `: ${detail.trim().slice(0, 200)}` : '.'}`)
  }
  return result
}

async function readConfig(exec) {
  const result = requireOk(await exec({ args: ['config', 'export', '-'] }), 'configuration export')
  let config
  try { config = JSON.parse(result.stdout) } catch { throw new Error('OpenCodex returned an unreadable configuration; run "ocx doctor" before retrying.') }
  if (!object(config)) throw new Error('OpenCodex returned an unexpected configuration shape; run "ocx doctor" before retrying.')
  if (!object(config.providers)) config.providers = {}
  return config
}

async function writeConfig(exec, config) {
  requireOk(await exec({ args: ['config', 'import', '-', '--yes', '--json'], input: `${JSON.stringify(config)}\n` }), 'configuration import')
}

export function opencodexDashboardUrl(port) {
  const value = Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : 10100
  return `http://localhost:${value}/`
}

function desiredProvider(existing, { model, key, models }) {
  const ids = []
  for (const entry of Array.isArray(models) ? models : []) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (validModel(id) && !ids.includes(id)) ids.push(id)
  }
  if (!ids.includes(model)) ids.unshift(model)
  const windows = {}
  const blind = []
  for (const entry of Array.isArray(models) ? models : []) {
    if (!object(entry) || !ids.includes(entry.id)) continue
    const context = Number(entry.contextWindow)
    if (Number.isSafeInteger(context) && context > 0) windows[entry.id] = context
    if (entry.vision !== true) blind.push(entry.id)
  }
  const previous = object(existing?.initialModelSelection) ? existing.initialModelSelection : null
  const provider = {
    ...(object(existing) ? existing : {}),
    adapter: 'openai-chat',
    baseUrl: BASE_URL,
    authMode: 'key',
    apiKey: key,
    defaultModel: model,
    models: ids,
    selectedModels: ids,
    initialModelSelection: {
      version: 1,
      registrationId: typeof previous?.registrationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previous.registrationId) ? previous.registrationId : randomUUID(),
      status: 'ready',
      modelCount: ids.length,
    },
    modelContextWindows: windows,
    noVisionModels: blind,
  }
  delete provider.disabled
  return provider
}

function validateJournal(journal) {
  if (!object(journal) || journal.version !== 1 || journal.tool !== 'codex' || journal.mode !== 'opencodex') throw new Error('Invalid native OpenCodex journal; remove the previous setup before retrying.')
  if (!(journal.previous === null || object(journal.previous)) || !object(journal.applied)) throw new Error('Invalid native OpenCodex journal records.')
  return journal
}

async function readJournal(file) {
  const state = await snapshot(file)
  if (state.raw === null) return { state, journal: null }
  let journal
  try { journal = JSON.parse(state.raw) } catch { throw new Error('Malformed native OpenCodex journal.') }
  return { state, journal: validateJournal(journal) }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

export async function applyOpencodex({ stateDir, exec, key, model, models = [], dryRun = false }) {
  if (!validModel(model)) throw new Error('Invalid public Codex model ID.')
  if (!validKey(key)) throw new Error('A valid API key is required for OpenCodex configuration.')
  if (typeof exec !== 'function') throw new Error('The OpenCodex CLI is required.')
  const journalFile = path.resolve(stateDir, 'native', 'opencodex.json')
  const run = async () => {
    const { state: journalBefore, journal } = await readJournal(journalFile)
    const config = await readConfig(exec)
    const current = object(config.providers[PROVIDER]) ? config.providers[PROVIDER] : null
    if (journal && !same(current, journal.applied)) throw new Error('The OpenCodex 1endpoint provider was modified outside the helper; review it or force removal before setup.')
    const applied = desiredProvider(current, { model, key, models })
    const previous = journal ? journal.previous : current
    const next = { ...config, providers: { ...config.providers, [PROVIDER]: applied } }
    const changed = !same(next, config)
    const nextJournal = { version: 1, tool: 'codex', mode: 'opencodex', provider: PROVIDER, previous, applied }
    const journalRaw = `${JSON.stringify(nextJournal, null, 2)}\n`
    const warnings = []
    if (!Array.isArray(applied.models) || applied.models.length < 2) warnings.push('Only one model was added to OpenCodex; the public catalog may have been unavailable.')
    if (!dryRun) {
      if (changed) await writeConfig(exec, next)
      if (journalRaw !== journalBefore.raw) await atomicReplace(journalFile, journalRaw, journalBefore)
    }
    return {
      dashboardUrl: opencodexDashboardUrl(config.port),
      journalPath: journalFile,
      configured: !dryRun || Boolean(journal),
      changed: dryRun ? false : changed,
      wouldChange: changed,
      dryRun,
      drift: false,
      model,
      modelCount: applied.models.length,
      warnings,
    }
  }
  return dryRun ? run() : withNativeLock(stateDir, run)
}

export async function inspectOpencodex({ stateDir, exec }) {
  const journalFile = path.resolve(stateDir, 'native', 'opencodex.json')
  const { journal } = await readJournal(journalFile)
  if (!journal) return { configured: false, drift: false }
  if (typeof exec !== 'function') return { configured: true, drift: false, unverified: true }
  try {
    const config = await readConfig(exec)
    const current = object(config.providers?.[PROVIDER]) ? config.providers[PROVIDER] : null
    return { configured: true, drift: !same(current, journal.applied), dashboardUrl: opencodexDashboardUrl(config.port), model: current?.defaultModel ?? null, modelCount: Array.isArray(current?.models) ? current.models.length : 0 }
  } catch { return { configured: true, drift: false, unverified: true } }
}

export async function removeOpencodex({ stateDir, exec, dryRun = false, force = false }) {
  if (typeof exec !== 'function') throw new Error('The OpenCodex CLI is required to restore its configuration.')
  const journalFile = path.resolve(stateDir, 'native', 'opencodex.json')
  const initial = await readJournal(journalFile)
  if (!initial.journal) return { configured: false, changed: false, drift: false, dryRun }
  const run = async () => {
    const { journal, state: journalBefore } = await readJournal(journalFile)
    const config = await readConfig(exec)
    const current = object(config.providers?.[PROVIDER]) ? config.providers[PROVIDER] : null
    const drift = !same(current, journal.applied)
    if (drift && !force) throw new Error('The OpenCodex 1endpoint provider was modified outside the helper; removal requires explicit force after review.')
    const providers = { ...config.providers }
    if (object(journal.previous)) providers[PROVIDER] = journal.previous
    else delete providers[PROVIDER]
    const next = { ...config, providers }
    if (!dryRun) {
      if (!same(next, config)) await writeConfig(exec, next)
      await atomicReplace(journalFile, null, journalBefore)
    }
    return { configured: dryRun, changed: !dryRun, wouldChange: true, drift, dryRun }
  }
  return dryRun ? run() : withNativeLock(stateDir, run)
}

/** True when a proxy answers on this OpenCodex home's configured port. */
export async function opencodexLiveness(exec, { env = process.env, home = os.homedir() } = {}) {
  try {
    const result = await exec({ args: ['resolve', '--json'] })
    const payload = JSON.parse(result.stdout)
    const port = Number(payload?.port?.effective) || null
    const configured = Number(payload?.port?.configured) || null
    if (payload?.liveness?.status !== 'live' || port === null || port !== configured) return { live: false, port: port || configured }
    // A listener on the same port can belong to a different OpenCodex home, which would not serve
    // the provider just configured. This home's own pid file is the ownership proof.
    const pidFile = path.join(env.OPENCODEX_HOME || path.join(home, '.opencodex'), 'ocx.pid')
    const pid = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim())
    if (!Number.isSafeInteger(pid) || pid <= 0) return { live: false, port }
    try { process.kill(pid, 0) } catch { return { live: false, port } }
    return { live: true, port }
  } catch { return { live: false, port: null } }
}

export async function syncCodexThroughOpencodex(exec) {
  const result = await exec({ args: ['sync'], timeout: 120000 })
  const lines = String(result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  const failure = lines.find(line => /refus|skipped|did not complete|error/i.test(line))
  return { ok: result.code === 0 && !failure, detail: failure ? failure.slice(0, 240) : null }
}
