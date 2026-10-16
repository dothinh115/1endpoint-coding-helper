#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { wizard, colorize } from './ui.mjs'
import { setup, reconfigure, remove, backup, loadState, stateRoot, validateTool } from './state.mjs'
import { launchClaude } from './adapters/claude.mjs'
import { launchDsh } from './adapters/dsh.mjs'
import { getCredential, saveCredential, removeCredential } from './credentials.mjs'
import { applyClaude, removeClaude, inspectClaude } from './native/claude.mjs'
import { applyDsh, removeDsh, inspectDsh } from './native/dsh.mjs'
import { nativeWarnings } from './native/diagnostics.mjs'
import { applyAgent, removeAgent, inspectAgent } from './native/agents.mjs'
import { launchAgent } from './adapters/agents.mjs'
import { findExecutable, TOOL_INFO, missingToolMessage } from './tools.mjs'

const HELP = `@1endpoint/coding-helper — native 1endpoint coding-tool setup

Usage:
  coding-helper setup --tool dsh|claude|openclaw|hermes --model PUBLIC_MODEL [--dry-run] [--update]
  coding-helper reconfigure --tool dsh|claude|openclaw|hermes --model PUBLIC_MODEL [--dry-run]
  coding-helper remove --tool dsh|claude|openclaw|hermes [--yes] [--dry-run] [--force] [--remove-key]
  coding-helper doctor --tool dsh|claude|openclaw|hermes
  coding-helper run --tool dsh|claude|openclaw|hermes [--profile web|headless|acp|sdk] -- [tool args]
  coding-helper backup --tool dsh|claude|openclaw|hermes
  coding-helper --help | --version

No arguments starts English/Tiếng Việt selection, then arrow-key action menus.
Tools: DeepSeek Harness (DSH), Claude Code, OpenClaw, Hermes. Color marks selection, warnings and errors only.
Wizard fetches public 1endpoint text models for independent tool/tier selections.
Claude setup/reconfigure accepts --haiku-model ID --sonnet-model ID --opus-model ID
and optional --fable-model ID for supporting versions. --model is the main/default fallback.
Node.js >=22.19 is required.
Paste your API key privately in the menu, or press Enter on Open Console to create one.
Pasted keys are saved automatically for the selected tool. Saved files are private plaintext, not encrypted.
ONEENDPOINT_API_KEY remains an optional environment override; never pass keys as arguments.
State: ONEENDPOINT_HELPER_HOME or ~/.1endpoint/coding-helper (recovery and connection metadata).
Setup updates native tool user settings while preserving unrelated preferences.
Restart, then launch the configured tool directly. Native home/config overrides are respected.
OpenClaw uses openclaw tui with its existing gateway; Hermes uses hermes.
Project/local settings and managed policies can override user settings; they are not rewritten.
Setup/doctor make no inference requests. Private recovery records may contain previous credentials.
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
    if (['--dry-run', '--update', '--yes', '--force', '--remove-key'].includes(arg)) { if (options[arg]) throw new Error('Duplicate option.'); options[arg] = true; continue }
    if (!['--tool', '--model', '--profile', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'].includes(arg)) throw new Error('Unknown option. Use --help. API keys must never be command-line arguments.')
    if (options[arg] !== undefined || !args.length || args[0].startsWith('-')) throw new Error('Missing or duplicate option value.')
    options[arg] = args.shift()
  }
  const allowed = { setup: ['--tool', '--model', '--profile', '--dry-run', '--update', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'], reconfigure: ['--tool', '--model', '--profile', '--dry-run', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'], remove: ['--tool', '--yes', '--dry-run', '--force', '--remove-key'], doctor: ['--tool'], backup: ['--tool'], run: ['--tool', '--profile'] }
  if (!allowed[command] || Object.keys(options).some(key => !allowed[command].includes(key)) || (command !== 'run' && forwarded.length)) throw new Error('Invalid command/options. Use --help.')
  validateTool(options['--tool'])
  if (options['--tool'] !== 'claude' && ['haiku', 'sonnet', 'opus', 'fable'].some(role => options[`--${role}-model`])) throw new Error('Tier model flags are only supported for Claude.')
  if (options['--profile'] && options['--tool'] !== 'dsh') throw new Error('--profile is only supported for DSH.')
  if (options['--profile'] && !['web', 'headless', 'acp', 'sdk'].includes(options['--profile'])) throw new Error('Choose --profile web, headless, acp or sdk.')
  return { command, options, forwarded }
}
async function main(argv, context = {}) {
  if (!argv.length) return wizard({ dispatch: main, getKeyStatus: async ({ tool }) => {
    const credential = await getCredential({ stateDir: stateRoot(), tool })
    return { available: Boolean(credential.key), source: credential.source }
  } })
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(HELP); return }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(metadata.version); return
  }
  const { command, options, forwarded } = parse(argv)
  const t = (en, vi) => context.language === 'vi' ? vi : en
  const tool = options['--tool'], stateDir = stateRoot()
  const agent = ['openclaw', 'hermes'].includes(tool)
  const nativeApi = tool === 'claude' ? { apply: applyClaude, remove: removeClaude, inspect: inspectClaude } : tool === 'dsh' ? { apply: applyDsh, remove: removeDsh, inspect: inspectDsh } : { apply: applyAgent, remove: removeAgent, inspect: inspectAgent }
  const startCommand = tool === 'dsh' ? 'dsh web' : tool === 'openclaw' ? 'openclaw tui' : tool
  const bin = ['setup', 'reconfigure', 'run', 'doctor'].includes(command) ? await findExecutable(TOOL_INFO[tool].command) : null
  if (['setup', 'reconfigure', 'run'].includes(command) && !bin) throw new Error(missingToolMessage(tool, context.language))
  if (command === 'remove') {
    if (!options['--yes'] && !options['--dry-run']) throw new Error(t('Confirm removal with --yes or preview with --dry-run.', 'Xác nhận xóa bằng --yes hoặc xem trước bằng --dry-run.'))
    // Validate both layers before changing either one; never trust paths from the legacy manifest.
    await remove({ stateDir, tool, dryRun: true, force: options['--force'] })
    const restored = await nativeApi.remove({ stateDir, tool, dryRun: Boolean(options['--dry-run']), force: Boolean(options['--force']) })
    if (restored.changed) console.log(t('Previous native tool settings restored.', 'Đã khôi phục cài đặt công cụ trước đó.'))
    const result = await remove({ stateDir, tool, dryRun: options['--dry-run'], yes: options['--yes'], force: options['--force'] })
    console.log(`${result.dryRun ? t('Preview removal', 'Xem trước việc xóa') : result.changed ? t('Removed helper configuration', 'Đã xóa cấu hình riêng') : t('Already removed', 'Cấu hình đã được xóa')}: ${tool}`)
    for (const file of result.files) console.log(`  ${file}`)
    if (options['--remove-key'] || context.removeKey) {
      await removeCredential({ stateDir, tool, dryRun: Boolean(options['--dry-run']) })
      console.log(options['--dry-run'] ? t('Saved-key removal preview only.', 'Chỉ xem trước việc xóa khóa đã lưu.') : t('Saved API key removed (if present).', 'Đã xóa khóa API đã lưu (nếu có).'))
    }
    if (result.force) console.log(t('Forced recovery restores only managed native fields and removes helper connection metadata. Unrelated settings are preserved.', 'Khôi phục cưỡng chế chỉ khôi phục các trường do helper quản lý và xóa thông tin kết nối. Giữ nguyên cài đặt không liên quan.'))
    console.log(t('Original tool settings, conversations and backups are unchanged.', 'Cài đặt gốc, hội thoại và bản sao lưu được giữ nguyên.'))
    return
  }
  if (command === 'setup' || command === 'reconfigure') {
    const selectedRoles = Object.fromEntries(['haiku', 'sonnet', 'opus', 'fable'].filter(role => options[`--${role}-model`]).map(role => [role, options[`--${role}-model`]]))
    const request = { stateDir, tool, model: options['--model'] || selectedRoles.sonnet, roles: Object.keys(selectedRoles).length ? selectedRoles : undefined, dryRun: options['--dry-run'], update: options['--update'] }
    const operation = command === 'reconfigure' ? reconfigure : setup
    // Preflight helper state and native targets before writing configuration.
    await operation({ ...request, dryRun: true })
    const credential = context.apiKey ? { key: context.apiKey } : await getCredential({ stateDir, tool })
    if (!credential.key && !request.dryRun) throw new Error(t('Add an API key in the menu before applying configuration.', 'Thêm khóa API trong menu trước khi áp dụng cấu hình.'))
    const nativeOptions = { stateDir, tool, model: request.model, roles: request.roles, key: credential.key || (request.dryRun ? 'dry-run-placeholder' : undefined), profile: options['--profile'] || 'web' }
    await nativeApi.apply({ ...nativeOptions, dryRun: true })
    const result = await operation(request)
    let native
    try { native = await nativeApi.apply({ ...nativeOptions, dryRun: Boolean(request.dryRun) }) }
    catch { throw new Error(t('Native settings were not applied. Connection metadata may have changed; retry setup/reconfigure after resolving the native configuration conflict.', 'Chưa áp dụng được cài đặt công cụ. Thông tin kết nối có thể đã đổi; xử lý xung đột cấu hình rồi chạy lại setup/reconfigure.')) }
    const nativePath = native.path || native.paths?.profilePatch
    if (nativePath) console.log(`${t('Native configuration', 'Cấu hình công cụ')}: ${nativePath}`)
    for (const warning of [...(native.warnings || []), ...await nativeWarnings({ tool })]) console.log(colorize(warning, 'warning'))
    console.log(`${result.dryRun ? t('Preview only', 'Chỉ xem trước') : result.changed ? t('Configured', 'Đã cấu hình') : t('Already configured', 'Cấu hình không thay đổi')}: ${tool}`)
    for (const file of result.files) console.log(`  ${file.path}`)
    console.log(t('Unrelated preferences, hooks and permissions are preserved. Project and managed policies still apply.', 'Giữ nguyên tùy chọn, hook và quyền không liên quan. Cài đặt project và chính sách quản trị vẫn áp dụng.'))
    if (!result.dryRun && context.apiKey && context.saveKey) {
      await saveCredential({ stateDir, tool, key: context.apiKey })
      console.log(t('API key saved privately for this tool. Local storage is not encrypted.', 'Đã lưu khóa API riêng cho công cụ này. Tệp lưu cục bộ không được mã hóa.'))
    } else if (context.apiKey) console.log(t('API key is available for this session only.', 'Khóa API chỉ dùng trong phiên này.'))
    else console.log(t('Use the interactive menu to paste an API key, or provide ONEENDPOINT_API_KEY in your environment.', 'Mở menu để dán khóa API, hoặc cung cấp ONEENDPOINT_API_KEY qua môi trường.'))
    if (!result.dryRun && !context.language) console.log('RESTART REQUIRED: close existing sessions, then run ' + startCommand + ' directly.')
    return
  }
  if (command === 'backup') { console.log('Secret-free configuration backup: ' + await backup({ stateDir, tool })); return }
  if (command === 'doctor' && !bin) console.log(colorize(missingToolMessage(tool, context.language), 'warning'))
  const { state } = await loadState(stateDir, tool)
  const credential = context.apiKey ? { key: context.apiKey, source: 'session' } : await getCredential({ stateDir, tool })
  if (command === 'doctor') {
    console.log(`${t('Configuration integrity: OK', 'Tính toàn vẹn cấu hình: OK')} (${tool})`)
    console.log(`${t('CLI installed', 'Đã cài CLI')}: ${bin ? t('yes', 'có') : t('no', 'chưa')}`)
    console.log(`${t('API key', 'Khóa API')}: ${credential.key ? t('available (not validated)', 'đã có (chưa xác thực)') : t('missing', 'chưa có')}`)
    console.log(t('No credential values displayed. No network or inference check performed.', 'Không hiển thị giá trị đăng nhập. Không kiểm tra mạng hoặc gọi mô hình.'))
    const native = await nativeApi.inspect({ stateDir, tool })
    console.log(`${t('Native setup', 'Cấu hình công cụ')}: ${native.configured && !native.drift ? t('applied', 'đã áp dụng') : t('missing or modified; run setup/reconfigure', 'chưa có hoặc đã thay đổi; chạy setup/reconfigure')}`)
    for (const warning of [...(native.warnings || []), ...await nativeWarnings({ tool })]) console.log(colorize(warning, 'warning'))
    if (!bin || !credential.key || !native.configured || native.drift) process.exitCode = 1
    return
  }
  const key = credential.key
  if (!key || /[\s\x00-\x1f\x7f-\x9f]/.test(key)) throw new Error(t('Add an API key through the interactive menu or set ONEENDPOINT_API_KEY.', 'Thêm khóa API qua menu hoặc đặt ONEENDPOINT_API_KEY.'))
  if (context.apiKey && context.saveKey) await saveCredential({ stateDir, tool, key })
  let launch
  try { launch = (agent ? launchAgent : tool === 'dsh' ? launchDsh : launchClaude)({ stateDir, tool, model: state.model, roleModels: state.roles, args: forwarded, profile: options['--profile'] || 'web' }) }
  catch { throw new Error('Unsupported tool arguments: routing, agent/plugin and permission-bypass overrides are not allowed.') }
  const native = await nativeApi.inspect({ stateDir, tool })
  if (!native.configured || native.drift) throw new Error(t('Apply native configuration with setup/reconfigure before starting the tool.', 'Áp dụng cấu hình công cụ bằng setup/reconfigure trước khi khởi chạy.'))
  // Use native homes/settings; the helper launcher is now optional, not a separate isolated profile.
  const args = agent ? launch.args : tool === 'claude' ? forwarded : ['--profile', options['--profile'] || native.profile || 'web', ...forwarded]
  const child = spawn(bin, args, { stdio: 'inherit', env: { ...process.env }, shell: false })
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
