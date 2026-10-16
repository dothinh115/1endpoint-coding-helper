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
export function launchAgent({ args = [], ...options }) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid tool arguments.')
  if (args.some(arg => arg.startsWith('-') && !['--help', '-h', '--version', '-v'].includes(arg))) throw new Error('Agent routing and permission overrides are not supported by the helper launcher. Launch the configured tool directly for other options.')
  if (options.tool === 'openclaw' && args.length) throw new Error('Use openclaw directly for commands other than the configured TUI.')
  const plan = createAgentPlan(options)
  return { ...plan, args: [...plan.args, ...args] }
}
