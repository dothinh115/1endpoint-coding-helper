import path from 'node:path'

export const CODEX_ROUTES = ['direct', 'opencodex']
export const BASE_URL = 'https://1endpoint.dev/api/v1'

/** Secret-free connection metadata for the helper state layer; the key never lands here. */
export function createCodexPlan({ stateDir, model, route = 'direct' }) {
  if (!CODEX_ROUTES.includes(route)) throw new Error('Choose the Codex route: direct or opencodex.')
  return {
    files: [{
      path: path.resolve(stateDir, 'codex', 'connection.json'),
      content: `${JSON.stringify({ provider: '1endpoint', baseUrl: BASE_URL, model, route }, null, 2)}\n`,
    }],
    hints: [
      'Direct setup writes the Codex user config.toml and a helper-owned model catalog.',
      'OpenCodex setup writes the 1endpoint provider into the OpenCodex configuration instead.',
    ],
  }
}
