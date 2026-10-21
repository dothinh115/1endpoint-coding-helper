import { resolve, join } from 'node:path'

const PROFILES = new Set(['web', 'headless', 'acp', 'sdk'])

function nonemptyString(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL characters`)
  }
}

/** Declarative DSH configuration; never reads or writes secrets. */
export function createDshPlan({ stateDir, model, profile = 'web' } = {}) {
  nonemptyString(stateDir, 'stateDir')
  nonemptyString(model, 'model')
  if (!PROFILES.has(profile)) {
    throw new TypeError(`Unsupported DSH profile: ${String(profile)}; use web, headless, acp, or sdk`)
  }
  const directory = resolve(stateDir, 'dsh')
  const home = join(directory, 'home')
  const overlay = join(directory, '1endpoint.patch.yml')
  const patches = [
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          '1endpoint': {
            displayName: '1endpoint',
            api: 'openai-completions',
            baseURL: 'https://1endpoint.dev/api/v1',
            apiKeyEnv: 'ONEENDPOINT_API_KEY',
            models: [{ id: model }],
          },
        },
      },
    },
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: '1endpoint', model },
    },
  ]
  return {
    files: [{ path: overlay, content: `${JSON.stringify(patches, null, 2)}\n` }],
    command: 'dsh',
    args: ['--profile', profile, '--patch', overlay],
    env: { DSH_HOME: home },
    hints: [
      'ONEENDPOINT_API_KEY must be present in the environment that starts DSH; the key is never stored in the overlay.',
      'DSH runs in an isolated home: existing user configuration is not read or merged, and patch config objects replace the entire entry config.',
      'The sdk-minimal profile is unsupported because it lacks the provider and default-model plugin entries.',
    ],
  }
}
