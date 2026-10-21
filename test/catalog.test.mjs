import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeModels, fetchModels, CATALOG_URL } from '../src/catalog.mjs'

test('catalog decodes sorted text-only valid IDs and strips terminal controls', () => {
  assert.deepEqual(decodeModels({ data: [
    { id: 'b', name: 'Beta' }, { id: 'a', name: '\u001bAlpha\n' },
    { id: 'image', type: 'image' }, { id: 'embed', type: 'embedding' },
    { id: 'bad\nID' }, { id: 'a', name: 'Alpha' }, null,
  ] }), [
    { id: 'a', name: 'Alpha', contextWindow: null, vision: false },
    { id: 'b', name: 'Beta', contextWindow: null, vision: false },
  ])
  assert.deepEqual(decodeModels({ data: [
    { id: 'v', display_name: 'Vision', context_window: 1000000, vision: { image: true } },
    { id: 'w', context_window: 'not-a-number', vision: { image: false } },
  ] }), [
    { id: 'v', name: 'Vision', contextWindow: 1000000, vision: true },
    { id: 'w', name: 'w', contextWindow: null, vision: false },
  ])
  assert.throws(() => decodeModels({ data: [] }))
  assert.throws(() => decodeModels({ data: 'bad' }))
})
test('catalog requests only public fixed URL with no auth or redirects', async () => {
  const models = await fetchModels({ fetchImpl: async (url, options) => {
    assert.equal(url, CATALOG_URL)
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert.deepEqual(options.headers, { accept: 'application/json' })
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { headers: { 'content-type': 'application/json' } })
  } })
  assert.equal(models[0].id, 'test-model')
})
test('catalog rejects HTTP, invalid JSON, empty, excessive length and content type safely', async () => {
  const replies = [new Response('secret-provider-error', { status: 500 }), new Response('not json', { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'text/html' } }), new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '3000000' } }), new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })]
  for (const reply of replies) await assert.rejects(fetchModels({ fetchImpl: async () => reply }), error => error.message.includes('Retry') && !error.message.includes('secret-provider-error'))
})
test('catalog bounded reader rejects actual oversized bytes without trusting length', async () => {
  await assert.rejects(fetchModels({ fetchImpl: async () => new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) }), /Could not load/)
})
test('catalog respects pre-aborted caller signal without private error reflection', async () => {
  await assert.rejects(fetchModels({ signal: AbortSignal.abort('fixture-secret'), fetchImpl: async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }) }), error => !error.message.includes('fixture-secret'))
})
