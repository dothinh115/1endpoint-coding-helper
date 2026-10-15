export const CATALOG_URL = 'https://1endpoint.dev/api/v1/models'
const MAX_BYTES = 2 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/
export function decodeModels(payload) {
  if (!payload || !Array.isArray(payload.data)) throw new Error('Model catalog has an invalid shape.')
  const models = new Map()
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !SAFE_ID.test(item.id)) continue
    if (item.type && item.type !== 'text') continue
    if (item.modelType && item.modelType !== 'text') continue
    const name = typeof item.name === 'string' ? item.name : typeof item.display_name === 'string' ? item.display_name : item.id
    models.set(item.id, { id: item.id, name: name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 200) })
  }
  if (!models.size) throw new Error('No compatible text models were returned by the catalog.')
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
export async function fetchModels({ signal, fetchImpl = globalThis.fetch } = {}) {
  const timeout = AbortSignal.timeout(10000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    // Public catalog only: never transmit user keys, cookies or inherited auth headers.
    response = await fetchImpl(CATALOG_URL, { signal: combined, redirect: 'error', headers: { accept: 'application/json' }, credentials: 'omit' })
    if (!response.ok) throw new Error('catalog_status')
    if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('catalog_type')
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('catalog_size')
    if (!response.body) throw new Error('catalog_empty')
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    const aborted = () => { void reader.cancel().catch(() => {}) }
    combined.addEventListener('abort', aborted, { once: true })
    try {
      while (true) {
        combined.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) throw new Error('catalog_size')
        chunks.push(value)
      }
      combined.throwIfAborted()
      return decodeModels(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } finally {
      combined.removeEventListener('abort', aborted)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } catch {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    throw new Error('Could not load the public 1endpoint model catalog. Retry or explicitly choose manual model ID entry.')
  }
}
