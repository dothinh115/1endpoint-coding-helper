import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { openConsole } from '../src/browser.mjs'

for (const [platform, command, prefix] of [['darwin', 'open', []], ['linux', 'xdg-open', []], ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler']]]) {
  for (const language of ['en', 'vi']) test(`Console ${platform} ${language} uses exact fixed URL without shell`, async () => {
    const calls = []
    await openConsole({ platform, language, url: 'https://evil.example', spawnImpl: (...args) => {
      calls.push(args)
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0))
      return child
    } })
    assert.deepEqual(calls, [[command, [...prefix, `https://console.1endpoint.dev/${language === 'vi' ? 'vi/' : ''}api-keys`], { shell: false, stdio: 'ignore', windowsHide: true }]])
  })
}
for (const failure of ['throw', 'error', 'exit', 'signal']) test(`browser ${failure} rejects with generic details`, async () => {
  await assert.rejects(openConsole({ spawnImpl: () => {
    if (failure === 'throw') throw new Error('secret')
    const child = new EventEmitter()
    queueMicrotask(() => failure === 'error' ? child.emit('error', new Error('secret')) : child.emit('close', failure === 'exit' ? 1 : null))
    return child
  } }), error => error.code === 'BROWSER_OPEN_FAILED' && !error.message.includes('secret'))
})

test('browser opener times out and terminates a hung process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let killed = false
  const child = new EventEmitter()
  child.kill = () => { killed = true }
  const pending = openConsole({ spawnImpl: () => child })
  const rejected = assert.rejects(pending, { code: 'BROWSER_OPEN_FAILED' })
  t.mock.timers.tick(5000)
  await rejected
  assert.equal(killed, true)
  child.emit('error', new Error('late private error'))
})
