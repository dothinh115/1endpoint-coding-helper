import path from 'node:path'
import fs from 'node:fs/promises'

// Metadata-only warnings. Never print values from environment or private configuration.
export async function nativeWarnings({ tool, env = process.env, cwd = process.cwd() }) {
  const warnings = []
  const names = Object.keys(env).filter(name => tool === 'claude'
    ? /^(?:ANTHROPIC_(?:MODEL|DEFAULT_.*_MODEL|BASE_URL|AUTH_TOKEN|API_KEY|CUSTOM_HEADERS)|CLAUDE_CODE_(?:USE_.*|OAUTH_TOKEN|SUBAGENT_MODEL))$/.test(name)
    : tool === 'codex'
      ? /^(?:OPENAI_BASE_URL|OPENAI_API_KEY|CODEX_API_KEY)$/.test(name)
      : /^(?:ONEENDPOINT_API_KEY|ONEENDPOINT_HELPER_API_KEY)$/.test(name))
  if (names.length) warnings.push(tool === 'codex'
    ? `Inherited Codex overrides are set (${names.join(', ')}). They can outrank the configured provider; review your shell environment if the selected model is not applied.`
    : `Inherited routing/authentication variables are set (${names.join(', ')}). They may override native settings; review your shell environment if the selected model is not applied.`)
  if (['openclaw', 'hermes'].includes(tool)) {
    const overrides = Object.keys(env).filter(name => tool === 'openclaw' ? /^(?:OPENCLAW_PROFILE|OPENCLAW_AGENT_DIR|PI_CODING_AGENT_DIR)$/.test(name) : /^(?:HERMES_INFERENCE_PROVIDER|OPENAI_BASE_URL|OPENAI_API_KEY|CUSTOM_BASE_URL|CUSTOM_API_KEY)$/.test(name))
    if (overrides.length) warnings.push(`Native agent overrides are set (${overrides.join(', ')}). Review the active profile if routing differs; values are not displayed.`)
    warnings.push(tool === 'openclaw' ? 'Existing agent-specific model/auth profiles and gateway lifecycle are preserved. Restart your existing gateway after setup; setup does not install or start a background service.' : 'Existing profiles, auxiliary models, fallback providers, hooks and tool permissions are preserved; explicit overrides may use other providers.')
  }
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
