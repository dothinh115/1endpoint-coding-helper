#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { wizard, colorize } from './ui.mjs'
import { setup, reconfigure, remove, backup, loadState, stateRoot, validateTool, assertSafePath } from './state.mjs'
import { launchClaude, childEnvironment } from './adapters/claude.mjs'
import { launchDsh } from './adapters/dsh.mjs'

const HELP = `@1endpoint/coding-helper — isolated 1endpoint coding-tool setup

Usage:
  coding-helper setup --tool dsh|claude --model PUBLIC_MODEL [--dry-run] [--update]
  coding-helper reconfigure --tool dsh|claude --model PUBLIC_MODEL [--dry-run]
  coding-helper remove --tool dsh|claude [--yes] [--dry-run] [--force]
  coding-helper doctor --tool dsh|claude
  coding-helper run --tool dsh|claude [--profile web|headless|acp|sdk] -- [tool args]
  coding-helper backup --tool dsh|claude
  coding-helper --help | --version

No arguments starts English/Tiếng Việt selection, then colored arrow-key action menus.
Wizard fetches public 1endpoint text models for independent tool/tier selections.
Claude setup/reconfigure accepts --haiku-model ID --sonnet-model ID --opus-model ID
and optional --fable-model ID for supporting versions. --model is the main/default fallback.
Node.js >=22.19 is required.
API key: export ONEENDPOINT_API_KEY in your shell; never pass it as an argument.
State: ONEENDPOINT_HELPER_HOME or ~/.1endpoint/coding-helper (isolated tool homes).
No existing DSH/Claude settings are edited. Setup/doctor make no API requests.
Claude launch excludes project/local settings, hooks and permissions; managed policy applies.
Run is explicit opt-in to tool startup and potentially billed requests. Normal permission prompts remain.
--update changes an existing helper-owned model only after hash validation; back up first.
`
function parse(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}, forwarded = []
  while (args.length) {
    const arg = args.shift()
    if (arg === '--') { forwarded.push(...args); break }
    if (['--dry-run', '--update', '--yes', '--force'].includes(arg)) { if (options[arg]) throw new Error('Duplicate option.'); options[arg] = true; continue }
    if (!['--tool', '--model', '--profile', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'].includes(arg)) throw new Error('Unknown option. Use --help. API keys must never be command-line arguments.')
    if (options[arg] !== undefined || !args.length || args[0].startsWith('-')) throw new Error('Missing or duplicate option value.')
    options[arg] = args.shift()
  }
  const allowed = { setup: ['--tool', '--model', '--dry-run', '--update', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'], reconfigure: ['--tool', '--model', '--dry-run', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'], remove: ['--tool', '--yes', '--dry-run', '--force'], doctor: ['--tool'], backup: ['--tool'], run: ['--tool', '--profile'] }
  if (!allowed[command] || Object.keys(options).some(key => !allowed[command].includes(key)) || (command !== 'run' && forwarded.length)) throw new Error('Invalid command/options. Use --help.')
  validateTool(options['--tool'])
  if (options['--tool'] !== 'claude' && ['haiku', 'sonnet', 'opus', 'fable'].some(role => options[`--${role}-model`])) throw new Error('Tier model flags are only supported for Claude.')
  if (options['--profile'] && options['--tool'] !== 'dsh') throw new Error('--profile is only supported for DSH.')
  if (options['--profile'] && !['web', 'headless', 'acp', 'sdk'].includes(options['--profile'])) throw new Error('Choose --profile web, headless, acp or sdk.')
  return { command, options, forwarded }
}
async function executable(command, env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue
    for (const suffix of extensions) {
      const file = path.resolve(directory, command + suffix)
      try { const stat = await fs.stat(file); if (stat.isFile()) { await fs.access(file, process.platform === 'win32' ? 0 : 1); return file } } catch {}
    }
  }
  return null
}
async function main(argv, context = {}) {
  if (!argv.length) return wizard({ dispatch: main })
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(HELP); return }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(metadata.version); return
  }
  const { command, options, forwarded } = parse(argv)
  const t = (en, vi) => context.language === 'vi' ? vi : en
  const tool = options['--tool'], stateDir = stateRoot()
  if (command === 'remove') {
    const result = await remove({ stateDir, tool, dryRun: options['--dry-run'], yes: options['--yes'], force: options['--force'] })
    console.log(`${result.dryRun ? t('Preview removal', 'Xem trước việc xóa') : result.changed ? t('Removed helper configuration', 'Đã xóa cấu hình riêng') : t('Already removed', 'Cấu hình đã được xóa')}: ${tool}`)
    for (const file of result.files) console.log(`  ${file}`)
    if (result.force) console.log(t('Forced recovery removes only fixed helper configuration paths; modified contents are not backed up.', 'Khôi phục cưỡng chế chỉ xóa đường dẫn cấu hình riêng cố định; nội dung đã sửa không được sao lưu.'))
    console.log(t('Existing user settings, runtime homes, backups and unknown files were preserved.', 'Đã giữ nguyên cài đặt gốc, dữ liệu phiên chạy, bản sao lưu và các tệp khác.'))
    return
  }
  if (command === 'setup' || command === 'reconfigure') {
    const selectedRoles = Object.fromEntries(['haiku', 'sonnet', 'opus', 'fable'].filter(role => options[`--${role}-model`]).map(role => [role, options[`--${role}-model`]]))
    const result = await (command === 'reconfigure' ? reconfigure : setup)({ stateDir, tool, model: options['--model'] || selectedRoles.sonnet, roles: Object.keys(selectedRoles).length ? selectedRoles : undefined, dryRun: options['--dry-run'], update: options['--update'] })
    console.log(`${result.dryRun ? t('Preview only', 'Chỉ xem trước') : result.changed ? t('Configured', 'Đã cấu hình') : t('Already configured', 'Cấu hình không thay đổi')}: ${tool}`)
    for (const file of result.files) console.log(`  ${file.path}`)
    if (context.language !== 'vi') for (const hint of result.hints || []) console.log(hint)
    else console.log(tool === 'claude' ? 'Không nạp cài đặt, hook và quyền project/local. Chính sách quản trị vẫn áp dụng; không bỏ qua quyền.' : 'DSH dùng home và cấu hình riêng; không sửa cài đặt gốc. Chế độ sdk-minimal không được hỗ trợ.')
    console.log(t('Set ONEENDPOINT_API_KEY in your shell, then use run --tool ', 'Đặt ONEENDPOINT_API_KEY trong môi trường shell, sau đó dùng run --tool ') + tool + t('. No key was saved.', '. Không lưu khóa API.'))
    if (!result.dryRun && !context.language) console.log(colorize('RESTART REQUIRED: existing sessions are not updated. Start a new session through coding-helper run --tool ' + tool + '.', 'warning'))
    return
  }
  if (command === 'backup') { console.log('Secret-free configuration backup: ' + await backup({ stateDir, tool })); return }
  const { state, plan } = await loadState(stateDir, tool)
  const bin = await executable(plan.command, process.env)
  if (command === 'doctor') {
    console.log(`${t('Configuration integrity: OK', 'Tính toàn vẹn cấu hình: OK')} (${tool})`)
    console.log(`${t('CLI installed', 'Đã cài CLI')}: ${bin ? t('yes', 'có') : t('no', 'chưa')}`)
    console.log(`ONEENDPOINT_API_KEY: ${process.env.ONEENDPOINT_API_KEY ? t('present (not validated)', 'đã có (chưa xác thực)') : t('missing', 'chưa có')}`)
    console.log(t('No credentials read from tool files. No network or inference check performed.', 'Không đọc thông tin đăng nhập từ tệp công cụ. Không kiểm tra mạng hoặc gọi mô hình.'))
    if (context.language !== 'vi') for (const hint of plan.hints || []) console.log(hint)
    if (!bin || !process.env.ONEENDPOINT_API_KEY) process.exitCode = 1
    return
  }
  if (!bin) throw new Error('CLI not found on PATH. Install the tool from its official distribution first.')
  const key = process.env.ONEENDPOINT_API_KEY
  if (!key || /[\r\n\0]/.test(key)) throw new Error('Set a valid ONEENDPOINT_API_KEY in the environment. It is never saved.')
  let launch
  try { launch = (tool === 'dsh' ? launchDsh : launchClaude)({ stateDir, model: state.model, roleModels: state.roles, args: forwarded, profile: options['--profile'] || 'web' }) }
  catch { throw new Error('Unsupported tool arguments: routing, agent/plugin and permission-bypass overrides are not allowed.') }
  await assertSafePath(launch.env.DSH_HOME || launch.env.CLAUDE_CONFIG_DIR)
  await fs.mkdir(launch.env.DSH_HOME || launch.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })
  const child = spawn(bin, launch.args, { stdio: 'inherit', env: childEnvironment(process.env, launch, key), shell: false })
  const signals = ['SIGINT', 'SIGTERM']
  const handlers = signals.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return [signal, handler] })
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Tool launch failed. Check the executable and local runtime.')))
    child.once('close', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); resolve() })
  }).finally(() => { for (const [signal, handler] of handlers) process.off(signal, handler) })
}
if (process.argv[1] && await fs.realpath(path.resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never serialize raw parser, filesystem or child error details: these can contain private bytes.
    const safe = error.code ? 'Local filesystem operation failed. Check helper state permissions and paths.' : error.message
    console.error(colorize('coding-helper: ' + safe, 'error', { output: process.stderr }))
    process.exitCode = 1
  })
}
export { main, parse }
