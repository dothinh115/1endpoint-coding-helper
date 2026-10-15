import { spawn } from 'node:child_process'

/** Explicitly open only the Console create-key page; never accepts a caller URL. */
export function openConsole({ language = 'en', spawnImpl = spawn, platform = process.platform } = {}) {
  const url = language === 'vi' ? 'https://console.1endpoint.dev/vi/api-keys' : 'https://console.1endpoint.dev/api-keys'
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  return new Promise((resolve, reject) => {
    let child, timer, settled = false
    const fail = () => {
      const error = new Error('Could not open Console. Try again or open the Console API keys page manually.')
      error.code = 'BROWSER_OPEN_FAILED'
      return error
    }
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child) {
        child.off('error', onError)
        child.off('close', onClose)
        // Absorb a late spawn error after timeout.
        child.on('error', () => {})
      }
      if (error) reject(error)
      else resolve()
    }
    const onError = () => finish(fail())
    const onClose = code => finish(code === 0 ? undefined : fail())
    try {
      child = spawnImpl(command, args, { shell: false, stdio: 'ignore', windowsHide: true })
      child.once('error', onError)
      child.once('close', onClose)
      timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish(fail())
      }, 5000)
    } catch { finish(fail()) }
  })
}
