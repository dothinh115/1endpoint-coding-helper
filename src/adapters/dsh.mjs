import { resolve, join } from 'node:path';

const PROFILES = new Set(['web', 'headless', 'acp', 'sdk']);
const ROUTING_FLAGS = new Set([
  '--patch', '--profile', '--from-default-profile', '--dump-default-config',
  '--config', '--config-file', '--home', '--dsh-home',
  '--provider', '--model', '--api-key', '--api-key-env', '--base-url', '--baseURL',
]);

function nonemptyString(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL characters`);
  }
}

/** Build an isolated, declarative DSH configuration; never reads or writes secrets. */
export function createDshPlan({ stateDir, model } = {}) {
  return launchDsh({ stateDir, model });
}

/** Return files and a launch specification; the caller materializes and executes it. */
export function launchDsh({ stateDir, model, args = [], profile = 'web' } = {}) {
  nonemptyString(stateDir, 'stateDir');
  nonemptyString(model, 'model');
  if (!PROFILES.has(profile)) {
    throw new TypeError(`Unsupported DSH profile: ${String(profile)}; use web, headless, acp, or sdk`);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('args must be an array of strings without NUL characters');
  }
  for (const arg of args) {
    // Commander permits unambiguous long-option abbreviations; reject those too.
    const flag = arg.split('=', 1)[0];
    if (flag.startsWith('--') && flag.length > 2
      && [...ROUTING_FLAGS].some((blocked) => blocked.startsWith(flag))) {
      throw new TypeError(`DSH routing override argument is not allowed: ${flag}`);
    }
  }
  const directory = resolve(stateDir, 'dsh');
  const home = join(directory, 'home');
  const overlay = join(directory, '1endpoint.patch.yml');
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
  ];
  return {
    files: [{ path: overlay, content: `${JSON.stringify(patches, null, 2)}\n` }],
    command: 'dsh',
    args: ['--profile', profile, '--patch', overlay, ...args],
    env: { DSH_HOME: home },
    hints: [
      'Set ONEENDPOINT_API_KEY in the child process environment; the key is never stored in the overlay.',
      'DSH runs in an isolated home: existing user configuration is not read or merged. Patch config objects replace the entire entry config.',
      'The sdk-minimal profile is unsupported because it lacks the provider and default-model plugin entries.',
    ],
  };
}
