import path from 'node:path'

export const MODEL_VARIABLES = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
export const CLAUDE_ROLES = [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }]
export const CLAUDE_OPTIONAL_ROLES = [{ id: 'fable', label: 'Fable' }]
export function createClaudePlan({ stateDir, model, roleModels }) {
  const directory = path.resolve(stateDir, 'claude')
  const settings = { model, env: Object.fromEntries(MODEL_VARIABLES.map(name => [name, model])) }
  if (roleModels) {
    settings.model = roleModels.sonnet || model
    settings.env.ANTHROPIC_MODEL = roleModels.sonnet || model
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = roleModels.haiku || model
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = roleModels.sonnet || model
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = roleModels.opus || model
    settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL = roleModels.fable || roleModels.opus || model
    settings.env.CLAUDE_CODE_SUBAGENT_MODEL = roleModels.sonnet || model
  }
  settings.env.ANTHROPIC_BASE_URL = 'https://1endpoint.dev/api/v1'
  return {
    files: [{ path: path.join(directory, 'settings.json'), content: JSON.stringify(settings, null, 2) + '\n' }],
    command: 'claude',
    args: ['--setting-sources', 'user', '--settings', path.join(directory, 'settings.json')],
    env: { CLAUDE_CONFIG_DIR: path.join(directory, 'home'), ...settings.env },
    hints: ['Project/local settings, permissions and hooks are intentionally excluded. Managed policy still applies.', 'Normal tool permission and workspace trust prompts remain enabled.'],
  }
}
export function launchClaude({ stateDir, model, roleModels, args = [] }) {
  // Do not allow forwarded flags to silently replace the routing/isolation contract.
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Tool arguments must be strings without NUL characters.')
  const blocked = /^(?:--(?:settings|setting-sources|model|fallback-model|agent|agents|plugin-dir|bare|dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode)(?:=|$)|-m)/
  if (args.some(arg => blocked.test(arg))) throw new Error('Routing, agent and permission-bypass overrides are not supported by the isolated launcher.')
  return { ...createClaudePlan({ stateDir, model, roleModels }), args: [...createClaudePlan({ stateDir, model, roleModels }).args, ...args] }
}
export function childEnvironment(env, plan, key) {
  const result = { ...env }
  for (const name of Object.keys(result)) {
    if (/^(?:ANTHROPIC_|CLAUDE_|DSH_)/.test(name) || /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/.test(name)) delete result[name]
  }
  Object.assign(result, plan.env)
  if (plan.command === 'claude') result.ANTHROPIC_AUTH_TOKEN = key
  result.ONEENDPOINT_API_KEY = key
  return result
}
