import path from 'node:path'
import fs from 'node:fs/promises'

// Metadata-only warnings. Never print values from environment or private configuration.
export async function nativeWarnings({ tool, env = process.env, cwd = process.cwd() }) {
  const warnings = []
  const names = Object.keys(env).filter(name => tool === 'claude'
    ? /^(?:ANTHROPIC_(?:MODEL|DEFAULT_.*_MODEL|BASE_URL|AUTH_TOKEN|API_KEY|CUSTOM_HEADERS)|CLAUDE_CODE_(?:USE_.*|OAUTH_TOKEN|SUBAGENT_MODEL))$/.test(name)
    : /^(?:ONEENDPOINT_API_KEY|ONEENDPOINT_HELPER_API_KEY)$/.test(name))
  if (names.length) warnings.push(`Inherited routing/authentication variables are set (${names.join(', ')}). They may override native settings; review your shell environment if the selected model is not applied.`)
  if (tool === 'claude') {
    let directory = path.resolve(cwd)
    while (true) {
      for (const name of ['settings.json', 'settings.local.json']) {
        try {
          const content = await fs.readFile(path.join(directory, '.claude', name), 'utf8')
          let settings
          try { settings = JSON.parse(content) } catch { warnings.push('A project Claude settings file is malformed; review it separately.'); continue }
          if (settings?.model || settings?.apiKeyHelper || settings?.env && Object.keys(settings.env).some(key => /^(?:ANTHROPIC_|CLAUDE_CODE_(?:USE_|OAUTH|SUBAGENT))/.test(key))) warnings.push('Project/local Claude settings contain model or authentication overrides. They are preserved and may take priority over the user configuration.')
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push('A project Claude settings file could not be inspected; review project overrides separately.') }
      }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    warnings.push('Managed organization policies still apply and are not changed by setup.')
  }
  return [...new Set(warnings)]
}
