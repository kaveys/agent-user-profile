#!/usr/bin/env node
/**
 * 宿主兼容性测试：同一个 index.js 在不同「残缺宿主」下必须照跑不崩。
 * 这里不启动 dsh，只伪造各种 ctx 形状——这正是兼容层要覆盖的现实：
 * 老版本 dsh 少服务、少事件主题、少 next 参数，新版本多，插件都得活。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { apply } = await import(`file://${join(HERE, 'index.js').replace(/\\/g, '/')}`)

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** 每个场景独立一个数据目录，避免互相看到对方写的 .host.json。 */
function scene(name) {
  const home = mkdtempSync(join(tmpdir(), `dsh-compat-${name}-`))
  process.env.DSH_USER_PROFILE_HOME = home
  return {
    home,
    caps: () => {
      const file = join(home, '.host.json')
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    },
    done: () => rmSync(home, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------- 场景 1：最老的宿主
// 只有 ctx.on，没有 inject / loader / llm / webServer / connection。
{
  const s = scene('minimal')
  const handlers = new Map()
  const ctx = { on: (topic, fn) => handlers.set(topic, fn) }
  let threw
  try {
    apply(ctx, {})
  } catch (error) {
    threw = error
  }
  check('最简宿主：apply 不抛', threw === undefined, threw?.message)
  check('最简宿主：两个钩子都注册上', handlers.has('session/event') && handlers.has('agent/pre-step'))
  const caps = s.caps()
  check('最简宿主：能力记录写成采集/注入可用、其余缺失',
    caps?.sessionEvents === true && caps?.preStep === true && caps?.webServer === false && caps?.llm === false)
  check('最简宿主：loader 记为缺失', caps?.loader === false)
  s.done()
}

// ---------------------------------------------------------------- 场景 2：钩子主题不存在
// 老宿主可能没有 agent/pre-step 这个主题，ctx.on 会抛：不能把插件拖死。
{
  const s = scene('no-prestep')
  const handlers = new Map()
  const ctx = {
    on: (topic, fn) => {
      if (topic === 'agent/pre-step') throw new Error('unknown hook')
      handlers.set(topic, fn)
    },
  }
  let threw
  try {
    apply(ctx, {})
  } catch (error) {
    threw = error
  }
  check('缺 pre-step：apply 不抛', threw === undefined, threw?.message)
  const caps = s.caps()
  check('缺 pre-step：记为缺失并写进 hooksFailed',
    caps?.preStep === false && Array.isArray(caps?.hooksFailed) && String(caps.hooksFailed[0]).includes('agent/pre-step'))
  s.done()
}

// ---------------------------------------------------------------- 场景 3：连 ctx.on 都没有
{
  const s = scene('no-on')
  let threw
  try {
    apply({}, {})
  } catch (error) {
    threw = error
  }
  check('无 ctx.on：apply 不抛', threw === undefined, threw?.message)
  check('无 ctx.on：能力全缺但仍有结论', s.caps()?.sessionEvents === false)
  s.done()
}

// ---------------------------------------------------------------- 场景 4：旧事件名照样统计
// 老版本把 tool/call 写成 tool_call、turn/end 写成 turn_end，采集不能瞎。
{
  const s = scene('aliases')
  const handlers = new Map()
  const ctx = {
    on: (topic, fn) => handlers.set(topic, fn),
    inject: undefined,
    loader: { import: async () => { throw new Error('none') } },
  }
  apply(ctx, {})
  const fire = (session, event) => handlers.get('session/event')?.(session, event)
  const session = { id: 'alias-session' }

  fire(session, { type: 'turn_start' })
  fire(session, { type: 'tool_call', data: { name: 'ops_bash', step: 1 } })
  fire(session, { type: 'tool_call', data: { name: 'ops_grep', step: 2 } })
  fire(session, { type: 'tool_result', data: { message: { isError: false } } })
  fire(session, { type: 'turn_end' })

  const month = new Date().toISOString().slice(0, 7)
  const obsFile = join(s.home, 'observations', `${month}.jsonl`)
  const rows = existsSync(obsFile)
    ? readFileSync(obsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const tools = rows.flatMap((row) => (row.tools ?? []).map((entry) => entry.tool))
  check('别名事件：仍然落盘一轮观测', rows.length === 1, `rows=${rows.length}`)
  check('别名事件：工具名收集正确', tools.includes('ops_bash') && tools.includes('ops_grep'), tools.join(','))
  s.done()
}

// ---------------------------------------------------------------- 场景 5：pre-step 不传 next
{
  const s = scene('no-next')
  process.env.DSH_USER_PROFILE_HOME = s.home
  const handlers = new Map()
  const ctx = { on: (topic, fn) => handlers.set(topic, fn), inject: undefined }
  apply(ctx, {})
  const preStep = handlers.get('agent/pre-step')
  let result
  let threw
  try {
    result = await preStep({ agent: { session: { id: 's' } } }, undefined)
  } catch (error) {
    threw = error
  }
  check('pre-step 无 next：不抛', threw === undefined, threw?.message)
  check('pre-step 无 next：原样返回（不拦不改）', result === undefined || typeof result === 'object')
  s.done()
}

console.log('')
if (failed > 0) {
  console.log(`兼容性测试：${failed} 项失败`)
  process.exit(1)
}
console.log('兼容性测试：全部通过')
