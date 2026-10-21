#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { wizard, colorize } from './ui.mjs'
import { setup, reconfigure, remove, backup, loadState, stateRoot, validateTool } from './state.mjs'
import { getCredential, saveCredential, removeCredential } from './credentials.mjs'
import { applyClaude, removeClaude, inspectClaude } from './native/claude.mjs'
import { applyDsh, removeDsh, inspectDsh } from './native/dsh.mjs'
import { applyCodex, removeCodex, inspectCodex, readCatalogTemplate } from './native/codex.mjs'
import { applyOpencodex, inspectOpencodex, removeOpencodex, opencodexRunner, opencodexLiveness, syncCodexThroughOpencodex, opencodexDashboardUrl } from './native/codex-opencodex.mjs'
import { nativeWarnings } from './native/diagnostics.mjs'
import { applyAgent, removeAgent, inspectAgent } from './native/agents.mjs'
import { findExecutable, findCodex, findOpencodex, TOOL_INFO, OPENCODEX, missingToolMessage, opencodexInstallMessage } from './tools.mjs'
import { fetchModels } from './catalog.mjs'

const HELP = `@1endpoint/coding-helper — native 1endpoint coding-tool setup

Usage:
  coding-helper setup --tool codex --route direct|opencodex --model PUBLIC_MODEL [--dry-run] [--update]
  coding-helper reconfigure --tool codex --route direct|opencodex --model PUBLIC_MODEL [--dry-run]
  coding-helper remove --tool codex [--yes] [--dry-run] [--force] [--remove-key]
  coding-helper doctor --tool codex
  coding-helper backup --tool codex
  coding-helper setup|reconfigure --tool dsh|claude|openclaw|hermes --model PUBLIC_MODEL [--dry-run] [--update]
  coding-helper remove --tool dsh|claude|openclaw|hermes [--yes] [--dry-run] [--force] [--remove-key]
  coding-helper doctor|backup --tool dsh|claude|openclaw|hermes
  coding-helper --help | --version

No arguments starts English/Tiếng Việt selection, then arrow-key action menus.
Tools: Codex, DeepSeek Harness (DSH), Claude Code, OpenClaw, Hermes. Color marks selection, warnings and errors only.
Codex supports two routes: direct writes the Codex user config.toml plus a helper-owned model catalog;
opencodex writes the 1endpoint provider into an installed OpenCodex proxy instead.
Wizard fetches public 1endpoint text models and adds every one of them to the selected route.
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
--update changes an existing helper-owned model only after hash validation; back up first.
`
const OPTION_VALUES = ['--tool', '--model', '--route', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model']
const FLAGS = ['--dry-run', '--update', '--yes', '--force', '--remove-key']

function parse(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}
  while (args.length) {
    const arg = args.shift()
    if (FLAGS.includes(arg)) { if (options[arg]) throw new Error('Duplicate option.'); options[arg] = true; continue }
    if (!OPTION_VALUES.includes(arg)) throw new Error('Unknown option. Use --help. API keys must never be command-line arguments.')
    if (options[arg] !== undefined || !args.length || args[0].startsWith('-')) throw new Error('Missing or duplicate option value.')
    options[arg] = args.shift()
  }
  const allowed = {
    setup: ['--tool', '--model', '--route', '--dry-run', '--update', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'],
    reconfigure: ['--tool', '--model', '--route', '--dry-run', '--haiku-model', '--sonnet-model', '--opus-model', '--fable-model'],
    remove: ['--tool', '--yes', '--dry-run', '--force', '--remove-key'],
    doctor: ['--tool'],
    backup: ['--tool'],
  }
  if (!allowed[command] || Object.keys(options).some(key => !allowed[command].includes(key))) throw new Error('Invalid command/options. Use --help.')
  validateTool(options['--tool'])
  if (options['--tool'] !== 'claude' && ['haiku', 'sonnet', 'opus', 'fable'].some(role => options[`--${role}-model`])) throw new Error('Tier model flags are only supported for Claude.')
  if (options['--route'] && options['--tool'] !== 'codex') throw new Error('--route is only supported for Codex.')
  if (options['--route'] && !['direct', 'opencodex'].includes(options['--route'])) throw new Error('Choose --route direct or opencodex.')
  if (options['--tool'] === 'codex' && (command === 'setup' || command === 'reconfigure') && !options['--route']) throw new Error('Choose --route direct or opencodex for Codex.')
  return { command, options }
}

function codexRoute(tool, options, state) {
  return options['--route'] || state?.route || 'direct'
}

/** The journal on disk is authoritative when the manifest is gone, so removal restores the right layer. */
async function codexRouteForRemoval({ stateDir, options, state }) {
  if (options['--route'] || state?.route) return codexRoute('codex', options, state)
  if (await fs.stat(path.join(stateDir, 'native', 'opencodex.json')).catch(() => null)) return 'opencodex'
  return 'direct'
}

/** Native dispatch per tool and, for Codex, per route. */
function nativeFor({ tool, route, stateDir, key, model, models, roles, profile, codexBin, ocxBin }) {
  if (tool === 'codex') {
    if (route === 'opencodex') {
      return {
        apply: options => applyOpencodex({ stateDir, exec: ocxBin ? opencodexRunner({ ocxBin }) : undefined, key, model, models, dryRun: options.dryRun }),
        remove: options => removeOpencodex({ stateDir, exec: ocxBin ? opencodexRunner({ ocxBin }) : undefined, dryRun: options.dryRun, force: options.force }),
        inspect: () => inspectOpencodex({ stateDir, exec: ocxBin ? opencodexRunner({ ocxBin }) : undefined }),
      }
    }
    return {
      apply: options => applyCodex({ stateDir, model, key, models, template: readCatalogTemplate({ codexBin }), dryRun: options.dryRun }),
      remove: options => removeCodex({ stateDir, dryRun: options.dryRun, force: options.force }),
      inspect: () => inspectCodex({ stateDir }),
    }
  }
  if (tool === 'claude') return {
    apply: options => applyClaude({ stateDir, model, roles, key, dryRun: options.dryRun }),
    remove: options => removeClaude({ stateDir, dryRun: options.dryRun, force: options.force }),
    inspect: () => inspectClaude({ stateDir }),
  }
  if (tool === 'dsh') return {
    apply: options => applyDsh({ stateDir, model, key, profile, dryRun: options.dryRun }),
    remove: options => removeDsh({ stateDir, dryRun: options.dryRun, force: options.force }),
    inspect: () => inspectDsh({ stateDir }),
  }
  return {
    apply: options => applyAgent({ stateDir, tool, model, key, dryRun: options.dryRun }),
    remove: options => removeAgent({ stateDir, tool, dryRun: options.dryRun, force: options.force }),
    inspect: () => inspectAgent({ stateDir, tool }),
  }
}

function startCommand(tool) {
  return tool === 'dsh' ? 'dsh web' : tool === 'openclaw' ? 'openclaw tui' : TOOL_INFO[tool].command
}

async function main(argv, context = {}) {
  if (!argv.length) return wizard({
    dispatch: main,
    getKeyStatus: async ({ tool }) => {
      const credential = await getCredential({ stateDir: stateRoot(), tool })
      return { available: Boolean(credential.key), source: credential.source }
    },
  })
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(HELP); return }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(metadata.version); return
  }
  const { command, options } = parse(argv)
  const t = (en, vi) => context.language === 'vi' ? vi : en
  const tool = options['--tool'], stateDir = stateRoot()
  let state = null
  if (tool === 'codex' && command !== 'setup') {
    try { state = (await loadState(stateDir, tool)).state } catch (error) { if (command !== 'remove' || options['--force']) throw error }
  }
  const route = tool === 'codex' && command === 'remove' ? await codexRouteForRemoval({ stateDir, options, state }) : codexRoute(tool, options, state)
  const codexInstall = tool === 'codex' ? await findCodex() : null
  const codexBin = codexInstall?.command ?? null
  const ocxBin = tool === 'codex' ? await findOpencodex() : null
  if (tool === 'codex') {
    if (['setup', 'reconfigure'].includes(command)) {
      if (!codexBin) throw new Error(missingToolMessage('codex', context.language))
      if (route === 'opencodex' && !ocxBin) throw new Error(opencodexInstallMessage(context.language))
      // Both routes own the same Codex client through different mechanisms, so they are exclusive.
      const other = route === 'opencodex' ? 'native/codex.json' : 'native/opencodex.json'
      if (await fs.stat(path.join(stateDir, other)).catch(() => null)) {
        throw new Error(t(`The other Codex route is already configured. Run remove --tool codex first, then set up this route.`, `Codex đang được cấu hình theo cách kia. Chạy remove --tool codex trước, rồi cấu hình lại theo cách này.`))
      }
    }
  } else {
    const bin = ['setup', 'reconfigure', 'doctor'].includes(command) ? await findExecutable(TOOL_INFO[tool].command) : null
    if (['setup', 'reconfigure'].includes(command) && !bin) throw new Error(missingToolMessage(tool, context.language))
    if (command === 'doctor' && !bin) console.log(colorize(missingToolMessage(tool, context.language), 'warning'))
  }
  const native = nativeFor({ tool, route, stateDir, model: state?.model || options['--model'], roles: state?.roles, profile: options['--profile'], models: context.models || [], codexBin, ocxBin })
  if (command === 'remove') {
    if (!options['--yes'] && !options['--dry-run']) throw new Error(t('Confirm removal with --yes or preview with --dry-run.', 'Xác nhận xóa bằng --yes hoặc xem trước bằng --dry-run.'))
    await remove({ stateDir, tool, dryRun: true, force: options['--force'] })
    const restored = await native.remove({ dryRun: Boolean(options['--dry-run']), force: Boolean(options['--force']) })
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
    const request = { stateDir, tool, model: options['--model'] || selectedRoles.sonnet, roles: Object.keys(selectedRoles).length ? selectedRoles : undefined, route: tool === 'codex' ? route : undefined, dryRun: options['--dry-run'], update: options['--update'] }
    const operation = command === 'reconfigure' ? reconfigure : setup
    // Preflight helper state and native targets before writing configuration.
    await operation({ ...request, dryRun: true })
    const credential = context.apiKey ? { key: context.apiKey } : await getCredential({ stateDir, tool })
    if (!credential.key && !request.dryRun) throw new Error(t('Add an API key in the menu before applying configuration.', 'Thêm khóa API trong menu trước khi áp dụng cấu hình.'))
    let models = []
    if (tool === 'codex') {
      models = context.models || []
      if (!models.length && !request.dryRun) {
        // Codex setup always registers the whole public catalog, so it needs the list even when
        // the command was scripted rather than started from the menu.
        try { models = await fetchModels() } catch { models = [] }
      }
      if (!request.dryRun && !models.length) throw new Error(t('The public model catalog is required for Codex setup; retry the model list.', 'Cần danh sách mô hình công khai để cấu hình Codex; hãy tải lại danh sách.'))
    }
    const nativeApi = nativeFor({ tool, route, stateDir, key: credential.key || (request.dryRun ? 'dry-run-placeholder' : undefined), model: request.model, roles: request.roles, profile: options['--profile'] || 'web', models, codexBin, ocxBin })
    await nativeApi.apply({ dryRun: true })
    const result = await operation(request)
    let applied
    try { applied = await nativeApi.apply({ dryRun: Boolean(request.dryRun) }) }
    catch { throw new Error(t('Native settings were not applied. Connection metadata may have changed; retry setup/reconfigure after resolving the native configuration conflict.', 'Chưa áp dụng được cài đặt công cụ. Thông tin kết nối có thể đã đổi; xử lý xung đột cấu hình rồi chạy lại setup/reconfigure.')) }
    if (applied.path) console.log(`${t('Native configuration', 'Cấu hình công cụ')}: ${applied.path}`)
    if (applied.catalogPath) console.log(`${t('Model catalog', 'Danh sách mô hình')}: ${applied.catalogPath}`)
    if (applied.modelCount) console.log(`${t('Models available', 'Số mô hình khả dụng')}: ${applied.modelCount}`)
    for (const warning of [...(applied.warnings || []), ...await nativeWarnings({ tool })]) console.log(colorize(warning, 'warning'))
    console.log(`${result.dryRun ? t('Preview only', 'Chỉ xem trước') : result.changed ? t('Configured', 'Đã cấu hình') : t('Already configured', 'Cấu hình không thay đổi')}: ${tool}`)
    for (const file of result.files) console.log(`  ${file.path}`)
    console.log(t('Unrelated preferences, hooks and permissions are preserved. Project and managed policies still apply.', 'Giữ nguyên tùy chọn, hook và quyền không liên quan. Cài đặt project và chính sách quản trị vẫn áp dụng.'))
    if (!result.dryRun && context.apiKey && context.saveKey) {
      await saveCredential({ stateDir, tool, key: context.apiKey })
      console.log(t('API key saved privately for this tool. Local storage is not encrypted.', 'Đã lưu khóa API riêng cho công cụ này. Tệp lưu cục bộ không được mã hóa.'))
    } else if (context.apiKey) console.log(t('API key is available for this session only.', 'Khóa API chỉ dùng trong phiên này.'))
    else console.log(t('Use the interactive menu to paste an API key, or provide ONEENDPOINT_API_KEY in your environment.', 'Mở menu để dán khóa API, hoặc cung cấp ONEENDPOINT_API_KEY qua môi trường.'))
    if (!result.dryRun && tool === 'codex' && route === 'opencodex') {
      await reportOpencodexNextSteps({ ocxBin, applied, language: context.language })
    } else if (!result.dryRun && tool === 'codex') {
      console.log(t(`NEXT: restart Codex Desktop, the IDE extension and any terminal session, then run ${startCommand(tool)}. No shell export is needed; the key is in your Codex config.`, `TIẾP THEO: khởi động lại Codex Desktop, extension IDE và mọi phiên terminal, rồi chạy ${startCommand(tool)}. Không cần export biến môi trường; khóa đã nằm trong cấu hình Codex.`))
    } else if (!result.dryRun && !context.language) console.log('RESTART REQUIRED: close existing sessions, then run ' + startCommand(tool) + ' directly.')
    return
  }
  if (command === 'backup') { console.log('Secret-free configuration backup: ' + await backup({ stateDir, tool })); return }
  if (command === 'doctor') {
    const { state: loaded } = tool === 'codex' ? { state: state } : await loadState(stateDir, tool)
    const credential = context.apiKey ? { key: context.apiKey, source: 'session' } : await getCredential({ stateDir, tool })
    const inspected = await native.inspect()
    console.log(`${t('Configuration integrity: OK', 'Tính toàn vẹn cấu hình: OK')} (${tool})`)
    if (tool !== 'codex') console.log(`${t('CLI installed', 'Đã cài CLI')}: ${await findExecutable(TOOL_INFO[tool].command) ? t('yes', 'có') : t('no', 'chưa')}`)
    if (tool === 'codex') {
      console.log(`${t('Route', 'Đường kết nối')}: ${loaded?.route || 'direct'}`)
      console.log(`${t('Codex Desktop detected', 'Phát hiện Codex Desktop')}: ${codexInstall?.surface === 'desktop' ? t('yes', 'có') : t('no', 'chưa')}`)
      console.log(`${t('Terminal codex detected', 'Phát hiện codex trên terminal')}: ${codexInstall?.terminal ? t('yes', 'có') : t('no', 'chưa')}`)
      console.log(`${t('OpenCodex installed', 'Đã cài OpenCodex')}: ${ocxBin ? t('yes', 'có') : t('no', 'chưa')}`)
    }
    console.log(`${t('API key', 'Khóa API')}: ${credential.key ? t('available (not validated)', 'đã có (chưa xác thực)') : t('missing', 'chưa có')}`)
    console.log(t('No credential values displayed. No network or inference check performed.', 'Không hiển thị giá trị đăng nhập. Không kiểm tra mạng hoặc gọi mô hình.'))
    console.log(`${t('Native setup', 'Cấu hình công cụ')}: ${inspected.configured && !inspected.drift ? t('applied', 'đã áp dụng') : t('missing or modified; run setup/reconfigure', 'chưa có hoặc đã thay đổi; chạy setup/reconfigure')}`)
    if (inspected.unverified) console.log(colorize(t('OpenCodex configuration could not be verified now; start or repair OpenCodex and run doctor again.', 'Chưa kiểm chứng được cấu hình OpenCodex; hãy khởi động hoặc sửa OpenCodex rồi chạy lại doctor.'), 'warning'))
    for (const warning of [...(inspected.warnings || []), ...await nativeWarnings({ tool })]) console.log(colorize(warning, 'warning'))
    const bin = tool === 'codex' ? (route === 'opencodex' ? ocxBin : codexBin) : await findExecutable(TOOL_INFO[tool].command)
    if (!bin || !credential.key || !inspected.configured || inspected.drift) process.exitCode = 1
    return
  }
  throw new Error('Unknown command. Use --help.')
}

/** Explicit, copy-pasteable handoff after an OpenCodex-route setup. */
async function reportOpencodexNextSteps({ ocxBin, applied, language }) {
  const t = (en, vi) => language === 'vi' ? vi : en
  const exec = opencodexRunner({ ocxBin })
  const liveness = await opencodexLiveness(exec)
  const port = liveness.port || OPENCODEX.defaultPort
  const dashboard = opencodexDashboardUrl(port)
  console.log('')
  console.log(t('NEXT STEPS', 'CÁC BƯỚC TIẾP THEO'))
  if (liveness.live) {
    console.log(t(`1. OpenCodex is running on port ${port}.`, `1. OpenCodex đang chạy trên cổng ${port}.`))
    const synced = await syncCodexThroughOpencodex(exec)
    if (synced.ok) console.log(t('   Codex model catalog refreshed through OpenCodex.', '   Đã làm mới danh sách mô hình Codex qua OpenCodex.'))
    else console.log(colorize(t(`   Codex was not pointed at OpenCodex automatically${synced.detail ? `: ${synced.detail}` : '.'} Run "ocx sync" yourself after fixing that.`, `   Chưa tự động trỏ Codex vào OpenCodex${synced.detail ? `: ${synced.detail}` : '.'} Hãy chạy "ocx sync" sau khi xử lý xong.`), 'warning'))
  } else {
    console.log(t('1. Start OpenCodex:', '1. Khởi động OpenCodex:'))
    console.log('   ocx start')
    console.log(t('   Then run "ocx sync" once so Codex is pointed at the proxy.', '   Sau đó chạy "ocx sync" một lần để trỏ Codex vào proxy.'))
  }
  console.log(t(`2. Open the OpenCodex dashboard: ${dashboard}`, `2. Mở dashboard OpenCodex: ${dashboard}`))
  console.log(t('3. Restart Codex Desktop, the IDE extension and any terminal session, then run codex normally.', '3. Khởi động lại Codex Desktop, extension IDE và mọi phiên terminal, rồi chạy codex bình thường.'))
  console.log(t('Codex keeps its own login and settings; OpenCodex only supplies the 1endpoint provider.', 'Codex giữ nguyên đăng nhập và cài đặt riêng; OpenCodex chỉ cung cấp provider 1endpoint.'))
  if (applied?.dashboardUrl && applied.dashboardUrl !== dashboard) console.log(t(`Configured dashboard URL: ${applied.dashboardUrl}`, `URL dashboard đã cấu hình: ${applied.dashboardUrl}`))
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
