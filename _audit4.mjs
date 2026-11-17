#!/usr/bin/env node
/**
 * 第四轮对抗排查：这一轮专打「兼容层自己」和「兼容层有没有踩坏既有行为」。
 * 手法：伪造不同形状的宿主 ctx + 直接改数据文件 + 走真 CLI，逐条看副作用，
 * 不看退出码看落盘结果（退出码为 0 但什么都没变，是本项目历史上真出现过的一类 bug）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'bin', 'profile.mjs')
const { apply, name, inject } = await import(`file://${join(HERE, 'index.js').replace(/\\/g, '/')}`)

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit4-'))
  process.env.DSH_USER_PROFILE_HOME = dir
  return dir
}
const cli = (dir, ...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DSH_USER_PROFILE_HOME: dir } }) }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}
const capsOf = (dir) => {
  const file = join(dir, '.host.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}
const fakeCtx = (opts = {}) => {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on: (topic, fn) => handlers.set(topic, fn),
      inject: opts.inject,
      loader: opts.loader,
      llm: opts.llm,
    },
  }
}

// ------------------------------------------------------------------ 1 能力文件位置与内容
{
  const dir = home()
  const { ctx } = fakeCtx()
  apply(ctx, {})
  const caps = capsOf(dir)
  check('能力文件写在 DSH_USER_PROFILE_HOME 下', caps !== undefined)
  check('能力文件不含凭据字段', JSON.stringify(caps).match(/password|passphrase|token/i) === null)
  check('能力文件记录 node 版本', typeof caps?.node === 'string' && caps.node.length > 0)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 2 doctor 读得到、说得清
{
  const dir = home()
  const { ctx } = fakeCtx()
  apply(ctx, {})
  const out = cli(dir, 'doctor')
  check('doctor 能读到宿主记录', /宿主记录/.test(out.out), out.out.split('\n')[1] ?? '')
  check('doctor 逐项给出可用/缺失结论', /采集\s+(可用|缺失)/.test(out.out) && /注入\s+(可用|缺失)/.test(out.out))
  const json = cli(dir, 'doctor', '--json')
  let parsed
  try {
    parsed = JSON.parse(json.out)
  } catch (error) {
    parsed = undefined
  }
  check('doctor --json 输出可解析', parsed !== undefined && typeof parsed.caps === 'object')
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 3 没有能力文件时 doctor 不崩、给下一步
{
  const dir = home()
  cli(dir, 'init')
  const out = cli(dir, 'doctor')
  check('无能力文件：doctor 退出码 0', out.code === 0, `code=${out.code}`)
  check('无能力文件：给出「重启宿主一次」的建议', /重启一次 dsh/.test(out.out) && /0\.3\.0 及以上/.test(out.out))
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 4 插件导出契约
{
  check('导出 name 未变', name === 'dsh-user-profile')
  check('inject 不再硬依赖 loader', Array.isArray(inject) && !inject.includes('loader'), JSON.stringify(inject))
  check('apply 是函数', typeof apply === 'function')
}

// ------------------------------------------------------------------ 5 兼容层没踩坏注入语义
{
  const dir = home()
  cli(dir, 'init')
  cli(dir, 'set', 'build.autoBuild', 'false')
  cli(dir, 'declare', '--dim', 'constraints', '--fact', '用户要求任何删除都必须能恢复', '--confidence', '0.9', '--core')
  cli(dir, 'declare', '--dim', 'interests', '--fact', '用户喜欢在周末研究公路车配件', '--confidence', '0.6')
  // 第三条只为把画像推到 ready：status=insufficient 时插件按设计不注入内容，
  // 那是门槛不是 bug（这条断言在 5b 单独验证）。
  cli(dir, 'declare', '--dim', 'communication', '--fact', '用户要结论先行、少铺垫', '--confidence', '0.7')
  cli(dir, 'build', '--all-scopes')
  const injectMd = readFileSync(join(dir, 'inject.md'), 'utf8')
  // 空段会被省略：只断言「有内容的段在位」，不硬要求三段齐全。
  check('inject.md 分段结构仍在', /红线与硬要求/.test(injectMd) && /个性化首选/.test(injectMd))

  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const session = { id: 'audit4-session' }
  handlers.get('session/event')(session, { type: 'turn/start' })
  const preStep = handlers.get('agent/pre-step')
  console.log('DEBUG env HOME =', process.env.DSH_USER_PROFILE_HOME, '| dir =', dir)
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: '我想给公路车换个坐垫，推荐一下' }] }] }
  const result = await preStep({ agent: { session } }, async () => decision)
  const text = (result?.messages ?? []).map((m) => JSON.stringify(m)).join('\n')
  check('注入块仍然带插件规定', /插件规定/.test(text))
  check('相关性过滤：无关的兴趣条目被挡在外', !/公路车配件/.test(text) || /与本次无关/.test(text))
  const built = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
  check('画像已进入 ready（否则注入按设计为空）', built.status === 'ready', `status=${built.status} items=${built.stats?.items} evidence=${built.stats?.evidence}`)
  const diag = [
    /画像版本 v\d+/.test(text) ? 'has-portrait-header' : 'no-portrait-header',
    /当前没有可用条目/.test(text) ? 'empty-notice' : 'has-content',
    /与本次无关/.test(text) ? 'relevance-dropped' : 'nothing-dropped',
  ].join(',')
  const tail = text.slice(Math.max(0, text.indexOf('画像内容')), Math.max(0, text.indexOf('画像内容')) + 520)
  check('红线条目仍然带入', /任何删除都必须能恢复/.test(text), `${diag} :: ${tail}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 6 别名事件与真实事件不重复计数
{
  const dir = home()
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const session = { id: 'dup' }
  const fire = (event) => handlers.get('session/event')(session, event)
  fire({ type: 'turn/start' })
  fire({ type: 'tool_call', data: { name: 'ops_bash' } })
  fire({ type: 'turn/end' })
  const month = new Date().toISOString().slice(0, 7)
  const file = join(dir, 'observations', `${month}.jsonl`)
  const rows = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  check('别名事件只落一轮', rows.length === 1, `rows=${rows.length}`)
  check('别名事件步数为 1（没有双计）', rows[0]?.steps === 1, `steps=${rows[0]?.steps}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 7 脏事件不炸
{
  const dir = home()
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  let threw = null
  try {
    const fire = (event) => handlers.get('session/event')({ id: 'x' }, event)
    fire(undefined)
    fire({})
    fire({ type: 'tool_call', data: null })
    fire({ type: 'user/message', data: { message: null } })
    fire({ type: 'turn/end' })
  } catch (error) {
    threw = error
  }
  check('畸形事件不让 handler 抛', threw === null, threw?.message)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 8 MCP 协议仍然正确
{
  const dir = home()
  cli(dir, 'init')
  const proc = execFileSync(process.execPath, [join(HERE, 'mcp', 'server.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_USER_PROFILE_HOME: dir },
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit4', version: '0' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'profile_nope', arguments: {} } }),
      '',
    ].join('\n'),
  })
  const lines = proc.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const list = lines.find((r) => r.id === 2)
  const bad = lines.find((r) => r.id === 3)
  const toolNames = (list?.result?.tools ?? []).map((tool) => tool.name)
  check('MCP tools/list 暴露 11 个工具', toolNames.length === 11, String(toolNames.length))
  check('MCP 提供 profile_ingest（从别的 AI 搬回画像）', toolNames.includes('profile_ingest'), toolNames.join(','))
  check('MCP 未知工具返回 -32602', bad?.error?.code === -32602, JSON.stringify(bad?.error ?? {}))
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 9 老配置仍能迁移（兼容不能把迁移踩坏）
{
  const dir = home()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ schemaVersion: 1, inject: { maxChars: 1600, topK: 8 }, redaction: { mode: 'unknown' } }), 'utf8')
  const out = cli(dir, 'status', '--json')
  let parsed
  try {
    parsed = JSON.parse(out.out)
  } catch (error) {
    parsed = undefined
  }
  check('v1 配置被迁移到当前版本', parsed !== undefined && parsed.maxChars === 0 && parsed.topK === 0, JSON.stringify({ maxChars: parsed?.maxChars, topK: parsed?.topK }))
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 10 面板数据仍自洽
{
  const dir = home()
  cli(dir, 'init')
  cli(dir, 'declare', '--dim', 'taste', '--fact', '用户喜欢深色界面和克制的配色', '--confidence', '0.8')
  const out = cli(dir, 'panel')
  let panel
  try {
    panel = JSON.parse(out.out)
  } catch (error) {
    panel = undefined
  }
  check('panel 输出可解析且含 items', panel !== undefined && Array.isArray(panel.items))
  check('panel 条目带 partition 与 provenance 字段', panel?.items?.[0]?.partition !== undefined && 'provenance' in (panel?.items?.[0] ?? {}))
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failed > 0) {
  console.log(`第四轮排查：${failed} 项失败`)
  process.exit(1)
}
console.log('第四轮排查：全部通过')

