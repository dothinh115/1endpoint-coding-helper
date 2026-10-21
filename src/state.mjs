import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createClaudePlan } from './adapters/claude.mjs'
import { createDshPlan } from './adapters/dsh.mjs'
import { createAgentPlan } from './adapters/agents.mjs'
import { createCodexPlan, CODEX_ROUTES } from './adapters/codex.mjs'
import { TOOL_INFO } from './tools.mjs'

export const tools = Object.keys(TOOL_INFO)
export function stateRoot(env = process.env) {
  return path.resolve(env.ONEENDPOINT_HELPER_HOME || path.join(os.homedir(), '.1endpoint', 'coding-helper'))
}
export function validateTool(tool) {
  if (!tools.includes(tool)) throw new Error('Choose --tool ' + tools.join('|') + '.')
  return tool
}
export function validateModel(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(model)) throw new Error('Provide a public model ID using --model (letters, digits, dot, slash, colon, plus, underscore or hyphen).')
  return model
}
export function planFor({ stateDir, tool, model, roles, route }) {
  validateTool(tool); validateModel(model)
  if (roles !== undefined) {
    if (tool !== 'claude' || !roles || typeof roles !== 'object' || Array.isArray(roles) || Object.keys(roles).some(key => !['haiku', 'sonnet', 'opus', 'fable'].includes(key))) throw new Error('Invalid Claude model role mapping.')
    for (const value of Object.values(roles)) validateModel(value)
  }
  if (tool === 'codex') return createCodexPlan({ stateDir, model, route: route || 'direct' })
  if (['openclaw', 'hermes'].includes(tool)) return createAgentPlan({ stateDir, tool, model })
  return (tool === 'dsh' ? createDshPlan : createClaudePlan)({ stateDir, model, roleModels: roles })
}
export const digest = data => createHash('sha256').update(data).digest('hex')

// Reject symlinks in every existing ancestor, including an overridden state root.
export async function assertSafePath(target) {
  const absolute = path.resolve(target)
  const root = path.parse(absolute).root
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error('Refusing a symbolic link in the helper state path.')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
async function optionalRead(file) {
  try { return await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function loadState(stateDir, tool) {
  validateTool(tool)
  await assertSafePath(stateDir)
  const file = path.join(stateDir, `${tool}.json`)
  await assertSafePath(file)
  const raw = await optionalRead(file)
  if (raw === null) throw new Error('Tool is not configured. Run setup first.')
  let state
  try { state = JSON.parse(raw) } catch { throw new Error('Invalid helper manifest; refusing to change state.') }
  if (!state || typeof state !== 'object' || Array.isArray(state) || !['files,model,tool', 'files,model,roles,tool', 'files,model,route,tool'].includes(Object.keys(state).sort().join(',')) || state.tool !== tool || typeof state.model !== 'string' || !Array.isArray(state.files)) throw new Error('Invalid helper manifest.')
  if (state.route !== undefined && (tool !== 'codex' || !CODEX_ROUTES.includes(state.route))) throw new Error('Invalid helper manifest.')
  const plan = planFor({ stateDir, tool, model: state.model, roles: state.roles, route: state.route })
  if (JSON.stringify(state.files) !== JSON.stringify(plan.files.map(file => ({ path: file.path, hash: digest(file.content) })))) throw new Error('Helper manifest does not match the generated plan.')
  for (const file of plan.files) {
    await assertSafePath(file.path)
    const content = await optionalRead(file.path)
    if (content === null || digest(content) !== digest(file.content)) throw new Error('Helper-owned configuration was modified. Review it before setup; refusing to overwrite or launch it.')
  }
  return { state, plan }
}
async function atomicWrite(file, content) {
  await assertSafePath(file)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 })
    await fs.rename(temp, file)
    await fs.chmod(file, 0o600)
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export async function setup({ stateDir, tool, model, roles, route, dryRun = false, update = false, autoBackup = false }) {
  const plan = planFor({ stateDir, tool, model, roles, route })
  await assertSafePath(stateDir)
  const manifest = path.join(stateDir, `${tool}.json`)
  await assertSafePath(manifest)
  const existing = await optionalRead(manifest)
  if (existing !== null) {
    const loaded = await loadState(stateDir, tool)
    if ((loaded.state.model !== model || JSON.stringify(loaded.state.roles) !== JSON.stringify(roles) || loaded.state.route !== (route || undefined)) && !update) throw new Error('A different model is configured. Use --update after reviewing the change.')
  } else {
    for (const file of plan.files) {
      await assertSafePath(file.path)
      if (await optionalRead(file.path) !== null) throw new Error('Unmanaged file exists in helper state; refusing to overwrite it.')
    }
  }
  if (dryRun) return { ...plan, changed: false, dryRun: true }
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const lock = path.join(stateDir, '.setup.lock')
  let handle
  try { handle = await fs.open(lock, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw new Error('Another setup may be active. Review the helper lock before retrying.'); throw error }
  try {
    // Repeat validation after acquiring the exclusive writer lock.
    if (await optionalRead(manifest) !== existing) throw new Error('State changed during setup; retry.')
    if (existing !== null) await loadState(stateDir, tool)
    const prior = []
    for (const file of plan.files) {
      await assertSafePath(file.path)
      const content = await optionalRead(file.path)
      if (existing === null && content !== null) throw new Error('Unmanaged file appeared during setup.')
      prior.push({ path: file.path, content })
    }
    const stored = existing === null ? null : JSON.parse(existing)
    if (stored && stored.model === model && JSON.stringify(stored.roles) === JSON.stringify(roles) && stored.route === (route || undefined)) return { ...plan, changed: false }
    if (existing !== null && autoBackup) {
      const previous = await loadState(stateDir, tool)
      await atomicWrite(path.join(stateDir, 'backups', `${tool}-${randomUUID()}.json`), JSON.stringify({ model: previous.state.model, ...(previous.state.roles ? { roles: previous.state.roles } : {}), ...(previous.state.route ? { route: previous.state.route } : {}), tool, files: previous.plan.files }, null, 2) + '\n')
    }
    try {
      for (const file of plan.files) await atomicWrite(file.path, file.content)
      const state = { tool, model, ...(roles ? { roles } : {}), ...(route ? { route } : {}), files: plan.files.map(file => ({ path: file.path, hash: digest(file.content) })) }
      await atomicWrite(manifest, JSON.stringify(state, null, 2) + '\n')
    } catch (error) {
      for (const file of prior.reverse()) {
        if (file.content === null) { await assertSafePath(file.path); await fs.unlink(file.path).catch(e => { if (e.code !== 'ENOENT') throw e }) }
        else await atomicWrite(file.path, file.content)
      }
      throw error
    }
    return { ...plan, changed: true }
  } finally { await handle.close(); await fs.unlink(lock) }
}
export async function reconfigure(options) {
  return setup({ ...options, update: true, autoBackup: true })
}

export async function remove({ stateDir, tool, dryRun = false, yes = false, force = false }) {
  validateTool(tool)
  if (!yes && !dryRun) throw new Error('Removal requires --yes. Preview with --dry-run first.')
  // Never trust paths from a possibly corrupt manifest, even in recovery mode.
  const files = [...planFor({ stateDir, tool, model: 'removal-placeholder' }).files.map(file => file.path), path.resolve(stateDir, `${tool}.json`)]
  async function inspect() {
    await assertSafePath(stateDir)
    const present = []
    for (const file of files) {
      await assertSafePath(file)
      try {
        const stat = await fs.lstat(file)
        if (!stat.isFile()) throw new Error('Refusing a non-file removal target.')
        present.push(file)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (present.length && !force) await loadState(stateDir, tool)
    return present
  }
  let present = await inspect()
  if (dryRun || !present.length) return { files: present, changed: false, dryRun, force }
  const lock = path.join(stateDir, '.setup.lock')
  let handle
  try { handle = await fs.open(lock, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw new Error('Another setup may be active. Review the helper lock before retrying.'); throw error }
  try {
    present = await inspect()
    for (const file of present) { await assertSafePath(file); await fs.unlink(file) }
    return { files: present, changed: present.length > 0, dryRun: false, force }
  } finally { await handle.close(); await fs.unlink(lock) }
}

export async function backup({ stateDir, tool }) {
  // Validate before creating anything, then serialize the snapshot with setup.
  await loadState(stateDir, tool)
  const lock = path.join(stateDir, '.setup.lock')
  let handle
  try { handle = await fs.open(lock, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw new Error('Another setup may be active. Review the helper lock before retrying.'); throw error }
  try {
    const { state, plan } = await loadState(stateDir, tool)
    const file = path.join(stateDir, 'backups', `${tool}-${randomUUID()}.json`)
    await atomicWrite(file, JSON.stringify({ model: state.model, ...(state.roles ? { roles: state.roles } : {}), tool, files: plan.files }, null, 2) + '\n')
    return file
  } finally { await handle.close(); await fs.unlink(lock) }
}
