const pty = require(process.argv[2])
const { stripVTControlCharacters } = require('node:util')
const [cli, action, root] = process.argv.slice(3)
const child = pty.spawn(process.execPath, [cli], { name: 'xterm-256color', cols: 120, rows: 32, cwd: root, env: process.env, useConpty: true })
let output = '', stage = 0
const timer = setTimeout(() => {
  console.error(`CLI did not return after ${action}: ${stripVTControlCharacters(output)}`)
  child.kill()
  process.exit(1)
}, 10000)
child.onData(data => {
  output += data
  const visible = stripVTControlCharacters(output)
  if (stage === 0 && visible.includes('Language / Ngôn ngữ')) {
    stage++
    child.write(action === 'Escape' ? '\u001b' : '\r')
  } else if (stage === 1 && action === 'Exit' && visible.includes('native user configuration')) {
    stage++
    child.write('\u001b[A\r')
  }
})
child.onExit(event => {
  clearTimeout(timer)
  const cancelled = action !== 'Escape' || stripVTControlCharacters(output).includes('Cancelled; no action taken')
  const passed = event.exitCode === 0 && stage === (action === 'Exit' ? 2 : 1) && cancelled
  console.log(JSON.stringify({ exitCode: event.exitCode, stage, cancelled, passed }))
  // Only this external test harness exits explicitly: the CLI must already have exited naturally.
  // node-pty 1.1 retains ConPTY pipes after onExit; do not kill an already-exited Windows PID.
  process.exit(passed ? 0 : 1)
})
