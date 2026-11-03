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
  const windows = process.platform === 'win32'
  const extensions = windows ? ['.exe', '.cmd', '.bat', ''] : ['']
  const pathKey = windows ? Object.keys(env).find(name => name.toUpperCase() === 'PATH') : 'PATH'
  for (let directory of (env[pathKey] || '').split(path.delimiter)) {
    if (windows && directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1)
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

/** Resolve the Codex client used as the catalog-template source; configuration setup does not require it. */
export async function findCodex({ env = process.env, home = os.homedir(), platform = process.platform, applicationRoots } = {}) {
  const terminal = await findExecutable(TOOL_INFO.codex.command, env)
  for (const candidate of codexDesktopCandidates({ platform, home, applicationRoots })) {
    if (await isExecutable(candidate)) return { command: candidate, surface: 'desktop', terminal }
  }
  return terminal ? { command: terminal, surface: 'terminal', terminal } : { command: null, surface: null, terminal: null }
}

/** Configuration setup never blocks on an uninstalled executable; Doctor reports one as a warning. */
export function missingExecutableWarning(tool, language = 'en') {
  const { name, command, installUrl } = TOOL_INFO[tool]
  return language === 'vi'
    ? `Không tìm thấy lệnh "${command}" trên PATH. Cấu hình vẫn được áp dụng; hãy cài ${name} trước khi chạy công cụ. Hướng dẫn cài đặt: ${installUrl}`
    : `"${command}" is not on PATH. Configuration is still applied; install ${name} before launching it. Installation guide: ${installUrl}`
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
