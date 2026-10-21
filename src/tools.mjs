import path from 'node:path'
import fs from 'node:fs/promises'

export const TOOL_INFO = {
  codex: {
    name: 'Codex',
    command: 'codex',
    installUrl: 'https://developers.openai.com/codex/',
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

export function missingToolMessage(tool, language = 'en') {
  const { name, command, installUrl } = TOOL_INFO[tool]
  return language === 'vi'
    ? `Chưa cài ${name} hoặc không tìm thấy lệnh "${command}" trên PATH. Cài đặt công cụ trước, sau đó mở lại terminal và chạy lại coding-helper. Hướng dẫn cài đặt: ${installUrl}`
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
