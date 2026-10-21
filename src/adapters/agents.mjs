import path from 'node:path'

export function createAgentPlan({ stateDir, tool, model }) {
  if (!['openclaw', 'hermes'].includes(tool)) throw new Error('Unsupported agent tool.')
  return {
    files: [{ path: path.resolve(stateDir, tool, 'connection.json'), content: JSON.stringify({ provider: '1endpoint', baseUrl: 'https://1endpoint.dev/api/v1', model }, null, 2) + '\n' }],
    command: tool,
    args: tool === 'openclaw' ? ['tui'] : [],
    env: {},
    hints: ['Restart the tool after setup. Native permissions, workspace trust and tool policies remain in effect.']
  }
}
