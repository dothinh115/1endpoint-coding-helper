import path from 'node:path'
import fs from 'node:fs/promises'

export const TOOL_INFO = {
  dsh: { name: 'DeepSeek Harness (DSH)', command: 'dsh', installUrl: 'https://github.com/deepseek-ai/deepseek-harness' },
  claude: { name: 'Claude Code', command: 'claude', installUrl: 'https://code.claude.com/docs/en/overview' },
  openclaw: { name: 'OpenClaw', command: 'openclaw', installUrl: 'https://docs.openclaw.ai/start/getting-started' },
  hermes: { name: 'Hermes', command: 'hermes', installUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation' }
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

export function missingToolMessage(tool, language = 'en') {
  const { name, command, installUrl } = TOOL_INFO[tool]
  return language === 'vi'
    ? `Chưa cài ${name} hoặc không tìm thấy lệnh "${command}" trên PATH. Cài đặt công cụ trước, sau đó mở lại terminal và chạy lại coding-helper. Hướng dẫn cài đặt: ${installUrl}`
    : `${name} is not installed or "${command}" is not on PATH. Install it first, then reopen your terminal and run coding-helper again. Installation guide: ${installUrl}`
}
