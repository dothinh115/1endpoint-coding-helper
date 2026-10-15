import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { select, colorize, wizard } from '../src/ui.mjs'

function tty({ raw = false } = {}) {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = raw
  input.rawCalls = []
  input.setRawMode = value => { input.isRaw = value; input.rawCalls.push(value); return input }
  let text = ''
  const output = new Writable({ write(chunk, encoding, done) { text += chunk.toString(); done() } })
  output.isTTY = true
  output.columns = 120
  return { input, output, text: () => text }
}
const choices = [{ label: 'Cancel', value: false }, { label: 'Confirm', value: true, description: 'Writes configuration' }]
const tick = () => new Promise(resolve => setImmediate(resolve))

function cleanListeners(input, output) {
  for (const event of ['data', 'error', 'end', 'close']) assert.equal(input.listenerCount(event), 0, event)
  assert.equal(output.listenerCount('error'), 0)
}

test('select uses arrows and Enter, restores raw mode and cursor', async () => {
  const { input, output, text } = tty()
  input.pause()
  const pending = select({ message: 'Confirm?', choices, input, output })
  assert.equal(input.isRaw, true)
  input.write('\u001b[B\r')
  assert.equal(await pending, true)
  assert.deepEqual(input.rawCalls, [true, false])
  assert.equal(input.isPaused(), true)
  assert.ok(text().endsWith('\u001b[?25h'))
  assert.match(text(), /↑\/↓ select/)
  assert.doesNotMatch(text(), /yes\/no|y\/n/i)
  cleanListeners(input, output)
})

test('up arrow wraps and original raw mode is preserved', async () => {
  const { input, output } = tty({ raw: true })
  const pending = select({ message: 'Choose', choices, input, output })
  input.write('\u001b[A\r')
  assert.equal(await pending, true)
  assert.equal(input.isRaw, true)
  cleanListeners(input, output)
})

test('typed y/n never changes default Cancel', async () => {
  const { input, output } = tty()
  const pending = select({ message: 'Confirm?', choices, input, output })
  input.write('yesyn\r')
  assert.equal(await pending, false)
  cleanListeners(input, output)
})

for (const [name, key] of [['Escape', '\u001b'], ['Ctrl-C', '\u0003']]) {
  test(`${name} cancels with a safe error and cleans terminal`, async () => {
    const { input, output, text } = tty()
    const pending = select({ message: 'Choose', choices, input, output })
    input.write(key)
    await assert.rejects(pending, error => error.code === 'UI_CANCELLED' && error.message === 'Selection cancelled; no action taken.')
    assert.equal(input.isRaw, false)
    assert.ok(text().endsWith('\u001b[?25h'))
    cleanListeners(input, output)
  })
}

test('split arrow sequences work', async () => {
  const { input, output } = tty()
  const pending = select({ message: 'Choose', choices, input, output })
  input.write('\u001b')
  input.write('[')
  input.write('B\n')
  assert.equal(await pending, true)
})

test('input failures are sanitized and clean listeners/raw mode', async () => {
  const { input, output, text } = tty()
  const pending = select({ message: 'Choose', choices, input, output })
  input.emit('error', new Error('secret filesystem details'))
  await assert.rejects(pending, error => error.code === 'UI_TERMINAL_ERROR' && !error.message.includes('secret'))
  assert.equal(input.isRaw, false)
  assert.ok(text().endsWith('\u001b[?25h'))
  cleanListeners(input, output)
})

test('NO_COLOR, FORCE_COLOR and TTY color policy', () => {
  assert.equal(colorize('heading', 'heading', { output: { isTTY: true }, env: { NO_COLOR: '', FORCE_COLOR: '1' } }), 'heading')
  assert.equal(colorize('plain', 'warning', { output: { isTTY: true }, env: { FORCE_COLOR: '0' } }), 'plain')
  assert.equal(colorize('plain', 'error', { output: { isTTY: false }, env: {} }), 'plain')
  assert.match(colorize('forced', 'success', { output: { isTTY: false }, env: { FORCE_COLOR: '1' } }), /^\u001b\[32mforced\u001b\[0m$/)
  assert.match(colorize('tty', 'heading', { output: { isTTY: true }, env: {} }), /^\u001b\[36m/)
})

async function keys(input, ...steps) {
  for (const step of steps) { input.write(step); await tick() }
}

test('wizard Doctor chooses tool using arrows and dispatches CLI argv', async () => {
  const { input, output, text } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
  await keys(input, '\r', '\u001b[B\u001b[B\u001b[B\r', '\u001b[B\r')
  await pending
  assert.deepEqual(calls, [['doctor', '--tool', 'claude']])
  assert.doesNotMatch(text(), /yes\/no|y\/n/i)
})

test('wizard setup free text is only model, Cancel is default confirmation', async () => {
  const { input, output, text } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
  await keys(input, '\r', '\r', '\r', '\r', '\r')
  await pending
  assert.deepEqual(calls, [])
  assert.match(text(), /Select public model for DSH/)
  assert.doesNotMatch(text(), /yes\/no|y\/n/i)
})

test('wizard reconfigure confirms independent tiers and discloses Claude safety', async () => {
  const { input, output, text } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
  await keys(input, '\r', '\u001b[B\r', '\u001b[B\r', '\r', '\r', '\u001b[B\r', '\r', '\u001b[B\r')
  await pending
  assert.deepEqual(calls, [['reconfigure', '--tool', 'claude', '--haiku-model', 'public-model', '--sonnet-model', 'second-model', '--opus-model', 'public-model', '--model', 'second-model']])
  assert.match(text(), /project\/local settings, hooks and permissions are excluded/)
  assert.match(text(), /Managed policy remains active; no permission bypass/)
  assert.match(text(), /Restart your Claude Code session/)
  assert.ok(text().indexOf('Claude safety:') < text().indexOf('Update helper-owned'))
})

test('wizard DSH run offers optional profiles', async () => {
  const { input, output } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
  await keys(input, '\r', '\u001b[A\u001b[A\r', '\r', '\u001b[B\u001b[B\r')
  await pending
  assert.deepEqual(calls, [['run', '--tool', 'dsh', '--profile', 'headless']])
})

test('wizard removal defaults to cancel and never dispatches', async () => {
  const { input, output } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
  await keys(input, '\r', '\u001b[B\u001b[B\r', '\r', '\r')
  await pending
  assert.deepEqual(calls, [])
})

test('wizard force recovery warns and requires explicit confirmation', async () => {
  const { input, output, text } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
  await keys(input, '\r', '\u001b[B\u001b[B\r', '\r', '\u001b[A\r', '\u001b[B\r')
  await pending
  assert.deepEqual(calls, [['remove', '--tool', 'dsh', '--yes', '--force']])
  assert.match(text(), /WARNING:.*without backup/)
})

test('wizard Escape safely cancels and Exit does not dispatch', async () => {
  for (const key of ['\u0003', '\u001b[A\r']) {
    const { input, output } = tty()
    const calls = []
    const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }, { id: 'second-model', name: 'Second Model' }] })
    if (key === '\u0003') input.write(key)
    else await keys(input, '\r', key)
    await pending
    assert.deepEqual(calls, [])
  }
})

test('large catalogs use a bounded scrolling viewport', async () => {
  const { input, output, text } = tty()
  output.rows = 12
  const many = Array.from({ length: 22 }, (_, i) => ({ label: `Model ${i + 1}`, value: i + 1 }))
  const pending = select({ message: 'Catalog', choices: many, input, output })
  assert.equal(text().split('\n').length - 1, 10)
  assert.doesNotMatch(text(), /Model 22/)
  input.write('\u001b[A\r')
  assert.equal(await pending, 22)
  assert.match(text(), /22\/22/)
  cleanListeners(input, output)
})

test('language is first and Vietnamese setup confirmation/restart stay localized', async () => {
  const { input, output, text } = tty()
  const calls = []
  const pending = wizard({ dispatch: (argv, context) => calls.push({ argv, context }), input, output, loadModels: async () => [{ id: 'public-model', name: 'Public Model' }] })
  assert.match(text(), /Language \/ Ngôn ngữ/)
  assert.doesNotMatch(text(), /Setup|Cấu hình/)
  await keys(input, '\u001b[B\r', '\r', '\r', '\r', '\u001b[B\r')
  await pending
  assert.deepEqual(calls, [{ argv: ['setup', '--tool', 'dsh', '--model', 'public-model'], context: { language: 'vi' } }])
  assert.match(text(), /Tạo cấu hình riêng/)
  assert.match(text(), /Khởi động lại phiên DSH/)
  const localized = text().slice(text().indexOf('cấu hình riêng'))
  assert.doesNotMatch(localized, /Confirm|Loading public|Restart your|Choose coding/)
})

test('catalog failure has explicit manual recovery; free text only model ID', async () => {
  const { input, output, text } = tty()
  const calls = []
  const pending = wizard({ dispatch: argv => calls.push(argv), input, output, loadModels: async () => { throw new Error('private detail') } })
  await keys(input, '\r', '\r', '\r', '\u001b[A\r', 'manual-model\r', '\u001b[B\r')
  await pending
  assert.deepEqual(calls, [['setup', '--tool', 'dsh', '--model', 'manual-model']])
  assert.match(text(), /Public model ID/)
  assert.doesNotMatch(text(), /private detail|y\/n|yes\/no/)
})

test('non-TTY selection rejects before attaching listeners', async () => {
  const { input, output } = tty()
  input.isTTY = false
  await assert.rejects(select({ message: 'Choose', choices, input, output }), /Non-interactive setup needs/)
  cleanListeners(input, output)
})
