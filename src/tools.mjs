import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

export const TOOL_INFO = {
  codex: {
    name: 'Codex',
    command: 'codex',
    installUrl: 'https://learn.chatgpt.com/docs',
    routes: ['direct', 'opencodex'],
  },
  dsh: { name: 'DeepSeek Harness (DSH)', command: 'dsh', installUrl: 'https://github.com/deepseek-ai/deepseek-harness' },
  claude: { name: 'Claude Code', command: 'claude', installUrl: 'https://code.claude.com/docs/en/overview' },
  openclaw: { name: 'OpenClaw', command: 'openclaw', installUrl: 'https://docs.openclaw.ai/start/getting-started' },
  hermes: { name: 'Hermes', command: 'hermes', installUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation' }
}

export const OPENCODEX = {
  name: 'OpenCodex',
  command: 'ocx',
  alternateCommand: 'opencodex',
  installUrl: 'https://github.com/lidge-jun/opencodex/releases/latest',
  defaultPort: 10100
}

export async function findExecutable(command, env = process.env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue
    for (const suffix of extensions) {
      const file = path.resolve(directory, command + suffix)
      try {
        const stat = await fs.stat(file)
        if (stat.isFile()) {
          await fs.access(file, process.platform === 'win32' ? 0 : 1)
          return file
        }
      } catch {}
    }
  }
  return null
}

export async function findOpencodex(env = process.env) {
  return await findExecutable(OPENCODEX.command, env) || await findExecutable(OPENCODEX.alternateCommand, env)
}

/**
 * Codex Desktop ships its own CLI inside the app bundle and reads the same user config, so a
 * Desktop-only installation is a supported surface even when `codex` is not on PATH.
 * Only paths verified on macOS are listed; other platforms rely on the terminal executable.
 */
function codexDesktopCandidates({ platform = process.platform, home = os.homedir(), applicationRoots } = {}) {
  if (platform !== 'darwin') return []
  const bundles = ['ChatGPT.app', 'Codex.app']
  const roots = applicationRoots ?? ['/Applications', path.join(home, 'Applications')]
  return roots.flatMap(root => bundles.map(bundle => path.join(root, bundle, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')))
}

async function isExecutable(file) {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    await fs.access(file, 1)
    return true
  } catch { return false }
}

/** Resolve the Codex client used for preflight and for the catalog template. */
export async function findCodex({ env = process.env, home = os.homedir(), platform = process.platform, applicationRoots } = {}) {
  const terminal = await findExecutable(TOOL_INFO.codex.command, env)
  for (const candidate of codexDesktopCandidates({ platform, home, applicationRoots })) {
    if (await isExecutable(candidate)) return { command: candidate, surface: 'desktop', terminal }
  }
  return terminal ? { command: terminal, surface: 'terminal', terminal } : { command: null, surface: null, terminal: null }
}

export function missingToolMessage(tool, language = 'en') {
  const { name, command, installUrl } = TOOL_INFO[tool]
  const detail = tool === 'codex'
    ? { en: 'Install Codex Desktop or the Codex CLI first', vi: 'Cài Codex Desktop hoặc Codex CLI trước' }
    : null
  if (language === 'vi') {
    return detail
      ? `Chưa cài ${name}: không tìm thấy ứng dụng Codex Desktop trong /Applications hay lệnh "${command}" trên PATH. ${detail.vi}, sau đó mở lại terminal và chạy lại coding-helper. Hướng dẫn cài đặt: ${installUrl}`
      : `Chưa cài ${name} hoặc không tìm thấy lệnh "${command}" trên PATH. Cài đặt công cụ trước, sau đó mở lại terminal và chạy lại coding-helper. Hướng dẫn cài đặt: ${installUrl}`
  }
  return detail
    ? `${name} is not installed: no Codex Desktop app was found in /Applications and "${command}" is not on PATH. ${detail.en}, then reopen your terminal and run coding-helper again. Installation guide: ${installUrl}`
    : `${name} is not installed or "${command}" is not on PATH. Install it first, then reopen your terminal and run coding-helper again. Installation guide: ${installUrl}`
}

/** Per-platform install guidance for the OpenCodex proxy; the helper never installs it itself. */
export function opencodexInstallMessage(language = 'en', platform = process.platform) {
  const npm = 'npm install -g @bitkyc08/opencodex'
  const guide = platform === 'darwin'
    ? `${npm}\n   # or the macOS .dmg: ${OPENCODEX.installUrl}`
    : platform === 'win32'
      ? `${npm}\n   # or the Windows .msi: ${OPENCODEX.installUrl}`
      : `${npm}\n   # or the Linux .AppImage/.deb: ${OPENCODEX.installUrl}`
  return language === 'vi'
    ? `Chưa cài OpenCodex hoặc không tìm thấy lệnh "${OPENCODEX.command}" trên PATH. Cài bằng một trong các cách sau rồi mở lại terminal:\n   ${guide}\n   Sau đó chạy lại coding-helper và chọn Codex → OpenCodex.`
    : `OpenCodex is not installed or "${OPENCODEX.command}" is not on PATH. Install it with one of these, then reopen your terminal:\n   ${guide}\n   Then run coding-helper again and choose Codex → OpenCodex.`
}
