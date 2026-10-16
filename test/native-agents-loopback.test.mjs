import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import YAML from 'yaml'
import { applyAgent } from '../src/native/agents.mjs'

for (const tool of ['openclaw', 'hermes']) test(`installed ${tool} reads native setup and completes Chat inference on loopback (opt-in)`, { skip: !process.env.CODING_HELPER_TEST_AGENTS, timeout: 80000 }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'native-agent-loopback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const seen = []
  const server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    seen.push({ path: request.url, model: body.model, auth: request.headers.authorization === 'Bearer dummy-local-agent-key' })
    if (request.url.endsWith('/models')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }))
      return
    }
    if (!request.url.endsWith('/chat/completions')) { response.writeHead(404); response.end('{}'); return }
    const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' }
    const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream')
      for (const packet of [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'LOCAL_AGENT_OK' }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]) response.write(`data: ${JSON.stringify(packet)}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'LOCAL_AGENT_OK' }, finish_reason: 'stop' }], usage }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, '.config'), XDG_CACHE_HOME: path.join(root, '.cache'), HERMES_HOME: path.join(root, '.hermes'), OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: path.join(root, '.openclaw'), OPENCLAW_CONFIG_PATH: path.join(root, '.openclaw', 'openclaw.json'), NO_COLOR: '1', TERM: 'dumb' }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  const applied = await applyAgent({ tool, stateDir: path.join(root, 'helper'), home: root, env, model: 'fixture-model', key: 'dummy-local-agent-key' })
  const config = tool === 'hermes' ? YAML.parse(await fs.readFile(applied.path, 'utf8')) : JSON.parse(await fs.readFile(applied.path, 'utf8'))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  if (tool === 'openclaw') {
    config.models.providers['1endpoint'].baseUrl = baseUrl
    config.agents.defaults.workspace = path.join(root, 'workspace')
    config.tools = { profile: 'minimal' }
    config.plugins = { enabled: false }
  } else {
    config.providers['1endpoint'].base_url = baseUrl
    config.agent = { max_turns: 1 }
    config.terminal = { backend: 'local' }
  }
  await fs.writeFile(applied.path, tool === 'hermes' ? YAML.stringify(config) : JSON.stringify(config))
  const args = tool === 'openclaw'
    ? ['agent', '--local', '--agent', 'main', '--session-id', 'local-fixture', '--message', 'Return LOCAL_AGENT_OK without using tools.', '--timeout', '30', '--json']
    : ['chat', '-q', 'Return LOCAL_AGENT_OK without using tools.', '--oneshot', '--quiet', '--max-turns', '1', '--run-budget', '30', '--toolsets', 'terminal']
  const child = spawn(tool, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, killSignal: 'SIGKILL' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => stdout += chunk)
  child.stderr.on('data', chunk => stderr += chunk)
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  assert.equal(result.code, 0, `Installed ${tool} failed (${result.signal || 'no signal'}): ${stderr.slice(-2000)}`)
  assert.ok(stdout.includes('LOCAL_AGENT_OK'))
  assert.ok(seen.some(call => call.path === '/v1/chat/completions' && call.model === 'fixture-model' && call.auth))
  assert.equal(seen.some(call => /responses|messages$/.test(call.path)), false)
})
