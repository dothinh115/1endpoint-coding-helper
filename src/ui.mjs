import { createInterface } from 'node:readline/promises'
import { fetchModels } from './catalog.mjs'
import * as claudeAdapter from './adapters/claude.mjs'

const palette = { heading: 36, info: 34, success: 32, warning: 33, error: 31, muted: 90, selected: 35 }

/** Semantic colors; NO_COLOR wins and FORCE_COLOR=0 disables colors. */
export function colorize(text, kind, { output = process.stdout, env = process.env } = {}) {
  const force = env.FORCE_COLOR
  const enabled = !Object.hasOwn(env, 'NO_COLOR') && (force !== undefined ? force !== '0' : Boolean(output.isTTY))
  const code = palette[kind]
  return enabled && code ? `\u001b[${code}m${text}\u001b[0m` : String(text)
}

function uiError(cancelled = false) {
  const error = new Error(cancelled ? 'Selection cancelled; no action taken.' : 'Terminal interaction failed; no action taken.')
  error.code = cancelled ? 'UI_CANCELLED' : 'UI_TERMINAL_ERROR'
  return error
}
const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')

/** Arrow-key menu. No typed answers are accepted. */
export async function select({ message, choices, input = process.stdin, output = process.stdout, language = 'en' }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Non-interactive setup needs setup --tool dsh|claude --model PUBLIC_MODEL.')
  }
  if (!Array.isArray(choices) || !choices.length || choices.some(choice => !choice || typeof choice.label !== 'string')) {
    throw new Error('Selection requires labeled choices.')
  }
  const wasRaw = Boolean(input.isRaw)
  const wasPaused = typeof input.isPaused === 'function' && input.isPaused()
  let index = 0, rendered = false, buffer = '', timer, settled = false
  const pageSize = Math.min(choices.length, 8, Math.max(1, (output.rows || 24) - 4))
  const lines = pageSize + 2
  // Conservative cell budget also prevents wrapping wide Unicode labels.
  const fit = text => {
    const chars = Array.from(clean(text))
    const limit = Math.max(8, Math.floor((output.columns || 120) / 2) - 1)
    return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('')
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      input.off('data', onData)
      input.off('error', onFailure)
      input.off('end', onFailure)
      input.off('close', onFailure)
      output.off('error', onFailure)
      try { input.setRawMode(wasRaw) } catch {}
      try { if (wasPaused) input.pause() } catch {}
      try { output.write('\u001b[?25h') } catch {}
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    function onFailure() { finish(uiError()) }
    function draw() {
      if (rendered) output.write(`\u001b[${lines}A\r`)
      output.write('\u001b[2K' + colorize(fit(message), 'heading', { output }) + '\n')
      const start = Math.min(Math.max(0, index - pageSize + 1), choices.length - pageSize)
      choices.slice(start, start + pageSize).forEach((choice, offset) => {
        const i = start + offset
        const text = `${i === index ? '❯' : ' '} ${choice.label}${choice.description ? ` — ${choice.description}` : ''}`
        output.write('\u001b[2K' + colorize(fit(text), i === index ? 'selected' : 'info', { output }) + '\n')
      })
      const hint = language === 'vi' ? '↑/↓ chọn · Enter xác nhận · Esc hủy' : '↑/↓ select · Enter accept · Esc cancel'
      output.write('\u001b[2K' + colorize(fit(`${index + 1}/${choices.length} · ${hint}`), 'muted', { output }) + '\n')
      rendered = true
    }
    function onData(chunk) {
      try {
        clearTimeout(timer)
        buffer += chunk.toString('utf8')
        while (buffer && !settled) {
          if (buffer[0] === '\u0003') return finish(uiError(true))
          if (buffer[0] === '\r' || buffer[0] === '\n') return finish(null, choices[index].value)
          if (buffer[0] === '\u001b') {
            if (buffer.startsWith('\u001b[A') || buffer.startsWith('\u001bOA')) {
              index = (index + choices.length - 1) % choices.length
              buffer = buffer.slice(3); draw(); continue
            }
            if (buffer.startsWith('\u001b[B') || buffer.startsWith('\u001bOB')) {
              index = (index + 1) % choices.length
              buffer = buffer.slice(3); draw(); continue
            }
            if (['\u001b', '\u001b[', '\u001bO'].includes(buffer)) {
              timer = setTimeout(() => finish(uiError(true)), 35)
              return
            }
            // Ignore other terminal navigation sequences (e.g. left/right).
            const sequence = buffer.match(/^\u001b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/)
            if (sequence) { buffer = buffer.slice(sequence[0].length); continue }
            return finish(uiError(true))
          }
          buffer = buffer.slice(1) // Free text, including y/n, cannot choose anything.
        }
      } catch { finish(uiError()) }
    }
    try {
      input.on('data', onData)
      input.on('error', onFailure)
      input.on('end', onFailure)
      input.on('close', onFailure)
      output.on('error', onFailure)
      input.setRawMode(true)
      output.write('\u001b[?25l')
      draw()
      input.resume()
    } catch { finish(uiError()) }
  })
}

async function modelQuestion(input, output, language = 'en') {
  const controller = new AbortController()
  const terminal = createInterface({ input, output, terminal: true })
  const abort = () => controller.abort()
  input.on('error', abort)
  input.on('end', abort)
  input.on('close', abort)
  terminal.on('SIGINT', abort)
  try {
    const model = (await terminal.question(colorize(language === 'vi' ? 'Mã mô hình công khai: ' : 'Public model ID: ', 'heading', { output }), { signal: controller.signal })).trim()
    if (!model || /[\x00-\x1f\x7f]/.test(model)) throw new Error(language === 'vi' ? 'Nhập mã mô hình công khai hợp lệ.' : 'Enter a valid public model ID.')
    return model
  } catch (error) {
    if (controller.signal.aborted) throw uiError(true)
    throw error
  } finally {
    input.off('error', abort)
    input.off('end', abort)
    input.off('close', abort)
    terminal.off('SIGINT', abort)
    terminal.close()
  }
}

/** Gather CLI arguments only. State and tool execution belong to dispatch. */
export async function wizard({ dispatch, input = process.stdin, output = process.stdout, loadModels = fetchModels }) {
  if (typeof dispatch !== 'function') throw new Error('Wizard requires a CLI dispatcher.')
  let language = 'en'
  const t = (en, vi) => language === 'vi' ? vi : en
  const choose = (message, choices) => select({ message, choices, input, output, language })
  const confirm = message => choose(message, [
    { label: t('Cancel', 'Hủy'), value: false, description: t('No changes', 'Không thay đổi') },
    { label: t('Confirm', 'Xác nhận'), value: true }
  ])
  try {
    language = await choose('Language / Ngôn ngữ', [
      { label: 'English', value: 'en' }, { label: 'Tiếng Việt', value: 'vi' }
    ])
    const action = await choose(t('1endpoint coding-helper · isolated configuration; no API key is requested or saved', '1endpoint coding-helper · cấu hình riêng; không yêu cầu hoặc lưu khóa API'), [
      { label: t('Setup', 'Cấu hình'), value: 'setup' },
      { label: t('Reconfigure', 'Cấu hình lại'), value: 'reconfigure' },
      { label: t('Remove', 'Xóa cấu hình'), value: 'remove' },
      { label: t('Doctor', 'Kiểm tra'), value: 'doctor', description: t('Local checks; no network requests', 'Kiểm tra cục bộ; không gửi yêu cầu mạng') },
      { label: t('Run', 'Chạy'), value: 'run', description: t('Starts the tool; may send billed requests', 'Khởi chạy công cụ; có thể phát sinh phí') },
      { label: t('Exit', 'Thoát'), value: 'exit' }
    ])
    if (action === 'exit') return
    const tool = await choose(t('Choose coding tool', 'Chọn công cụ lập trình'), [
      { label: 'DSH', value: 'dsh' }, { label: 'Claude Code', value: 'claude' }
    ])
    const argv = [action, '--tool', tool]
    if (action === 'setup' || action === 'reconfigure') {
      let models, manual = false
      while (!models && !manual) {
        output.write(colorize(t('Loading public 1endpoint model catalog (no API key)...\n', 'Đang tải danh sách mô hình công khai từ 1endpoint (không dùng khóa API)...\n'), 'info', { output }))
        try {
          models = await loadModels()
          if (!Array.isArray(models) || !models.length) throw new Error('Empty catalog')
        } catch {
          models = undefined
          const recovery = await choose(t('Model catalog unavailable. Choose explicitly how to continue.', 'Không tải được danh sách mô hình. Chọn cách tiếp tục.'), [
            { label: t('Cancel', 'Hủy'), value: 'cancel' },
            { label: t('Retry catalog', 'Tải lại danh sách'), value: 'retry' },
            { label: t('Manual model ID', 'Nhập mã mô hình'), value: 'manual', description: t('Enter a public model ID yourself', 'Tự nhập mã mô hình công khai') }
          ])
          if (recovery === 'cancel') return
          manual = recovery === 'manual'
        }
      }
      const pickModel = async label => manual
        ? modelQuestion(input, output, language)
        : choose(t(`Select public model for ${label}`, `Chọn mô hình công khai cho ${label}`), models.map(model => ({ label: model.name || model.id, value: model.id, description: model.name && model.name !== model.id ? model.id : undefined })))
      if (tool === 'dsh') argv.push('--model', await pickModel('DSH'))
      else {
        const roles = claudeAdapter.CLAUDE_ROLES
        const optionalRoles = claudeAdapter.CLAUDE_OPTIONAL_ROLES || []
        let activeRoles = [...roles]
        if (optionalRoles.length) {
          const extra = await choose(t('Claude tier support depends on your installed version; no version is guessed.', 'Các cấp Claude tùy thuộc phiên bản đã cài; không tự suy đoán phiên bản.'), [
            { label: t('Standard Haiku / Sonnet / Opus', 'Các cấp chuẩn Haiku / Sonnet / Opus'), value: false },
            { label: t('Include optional tiers', 'Thêm cấp tùy chọn'), value: true, description: t('Only if your installed Claude supports ', 'Chỉ chọn nếu Claude đã cài hỗ trợ ') + optionalRoles.map(role => role.label).join(', ') }
          ])
          if (extra) activeRoles.push(...optionalRoles)
        }
        const selected = {}
        for (const role of activeRoles) {
          const id = typeof role === 'string' ? role : role.id
          selected[id] = await pickModel(typeof role === 'string' ? role : role.label)
          argv.push(`--${id}-model`, selected[id])
        }
        argv.push('--model', selected.sonnet)
      }
      if (tool === 'claude') output.write(colorize(t('Claude safety: project/local settings, hooks and permissions are excluded. Managed policy remains active; no permission bypass is enabled.\n', 'An toàn Claude: không dùng cài đặt dự án/cục bộ, móc thực thi và quyền của dự án. Chính sách quản trị vẫn áp dụng; không bật bỏ qua quyền.\n'), 'warning', { output }))
      if (!await confirm(t(`${action === 'setup' ? 'Create' : 'Update'} helper-owned ${tool} configuration? Existing user settings are not edited.`, `${action === 'setup' ? 'Tạo' : 'Cập nhật'} cấu hình riêng cho ${tool}? Không sửa cài đặt hiện có của người dùng.`))) return
    }
    if (action === 'run' && tool === 'dsh') {
      const profile = await choose(t('Choose DSH launch profile', 'Chọn chế độ khởi chạy DSH'), [
        { label: t('Default (web)', 'Mặc định (web)'), value: null },
        ...['web', 'headless', 'acp', 'sdk'].map(value => ({ label: value, value }))
      ])
      if (profile) argv.push('--profile', profile)
    }
    if (action === 'remove') {
      const mode = await choose(t('Remove helper configuration', 'Xóa cấu hình riêng'), [
        { label: t('Cancel', 'Hủy'), value: 'cancel' },
        { label: t('Normal removal', 'Xóa thông thường'), value: 'normal', description: t('Validate ownership and integrity', 'Kiểm tra quyền sở hữu và tính toàn vẹn') },
        { label: t('Force removal recovery', 'Khôi phục bằng xóa cưỡng chế'), value: 'force', description: t('WARNING: modified fixed helper files may be deleted without backup', 'CẢNH BÁO: tệp cấu hình đã sửa có thể bị xóa mà không sao lưu') }
      ])
      if (mode === 'cancel') return
      if (mode === 'force') output.write(colorize(t('WARNING: Force recovery deletes fixed helper configuration paths, including modified contents, without backup.\n', 'CẢNH BÁO: xóa cưỡng chế xóa các đường dẫn cấu hình riêng cố định, kể cả nội dung đã sửa, không sao lưu.\n'), 'warning', { output }))
      if (!await confirm(mode === 'force' ? t('Confirm forced recovery deletion without backup?', 'Xác nhận xóa cưỡng chế không sao lưu?') : t('Confirm removal of helper-owned configuration?', 'Xác nhận xóa cấu hình riêng?'))) return
      argv.push('--yes')
      if (mode === 'force') argv.push('--force')
    }
    const result = await dispatch(argv, { language })
    if (action === 'setup' || action === 'reconfigure') {
      const warning = t(`Restart your ${tool === 'dsh' ? 'DSH' : 'Claude Code'} session to apply. Existing sessions do not update automatically. Start a new session through coding-helper.\n`, `Khởi động lại phiên ${tool === 'dsh' ? 'DSH' : 'Claude Code'} để áp dụng. Phiên hiện có không tự cập nhật. Mở phiên mới thông qua coding-helper.\n`)
      const colored = colorize(warning, 'warning', { output })
      output.write(colored === warning ? warning : `\u001b[1m${colored}\u001b[0m`)
    }
    return result
  } catch (error) {
    if (error.code === 'UI_CANCELLED') {
      output.write(colorize(t('Cancelled; no action taken.\n', 'Đã hủy; không thực hiện thao tác.\n'), 'warning', { output }))
      return
    }
    throw error
  }
}
