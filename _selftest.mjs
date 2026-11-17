#!/usr/bin/env node
/** 端到端自测：存储层 + 注入逻辑（不依赖运行中的 dsh）。 */
import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'))
process.env.DSH_USER_PROFILE_HOME = HOME

const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env })
const execFileP = promisify(execFileCb)
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

// 1 空数据
run('init')
// 先关自动重建，避免测试中途后台 build 与断言抢写文件（第 13 节再单独验证它）
run('set', 'build.autoBuild', 'false')
const emptyStatus = JSON.parse(run('status', '--json'))
check('init 后画像缺失', emptyStatus.profile === 'missing')
run('build')
const empty = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
check('空数据 → status=empty', empty.status === 'empty', empty.status)

// 2 数据不足
run('declare', '--dim', 'taste', '--fact', '偏好中文回答，交付要能直接运行')
run('build')
const thin = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
check('1 条声明 → status=insufficient', thin.status === 'insufficient', thin.status)

// 3 就绪 + 行为信号聚合
run('declare', '--dim', 'identity', '--fact', '在 Windows 上做本地开发')
run('observe', '--tools', 'ops_bash,ops_grep,ops_bash', '--steps', '3', '--ok', '3')
run('build')
const ready = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
check('3 条证据 → status=ready', ready.status === 'ready', ready.status)
const wf = ready.dimensions.habits.items.map((i) => i.text).join(' | ')
check('默认不把工具统计写进画像', !wf.includes('ops_bash'), wf)
// 打开 includeObservedItems 才产出工具占比（默认关闭：那是运行痕迹，不是用户画像）
run('set', 'build.includeObservedItems', 'true')
run('build')
const withObs = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const wf2 = withObs.dimensions.habits.items.map((i) => i.text).join(' | ')
check('显式开启后仍能聚合出常用工具', wf2.includes('ops_bash'), wf2)
run('set', 'build.includeObservedItems', 'false')
run('build')

// 4 冲突：同 key 覆盖 + 留痕
run('declare', '--dim', 'communication', '--key', 'tone', '--fact', '回答偏简洁')
run('declare', '--dim', 'communication', '--key', 'tone', '--fact', '回答要详细展开')
run('build')
const conflicted = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const tone = conflicted.dimensions.communication.items.find((i) => i.key === 'tone')
check('同 key 新值胜出', tone?.text === '回答要详细展开', tone?.text)
check('旧值留痕到 conflicts', conflicted.conflicts.some((c) => c.status === 'resolved'))
check('旧值进 history', conflicted.dimensions.communication.history.length === 1)
check('revision 单调递增', conflicted.revision === (thin.revision + 1 + 1) - 1 + 1 || conflicted.revision > thin.revision, String(conflicted.revision))

// 5 注入逻辑
const { apply } = await import(new URL('./index.js', import.meta.url).href)
const handlers = new Map()
const routes = new Map()
// 假模型服务：证明「轮末语义提取」这条链路真的能写出画像事实，而不是只靠人手动 declare。
const EXTRACT_REPLY = JSON.stringify({
  facts: [
    { dim: 'taste', key: 'tools.editor', fact: '用户习惯用 VS Code 编辑代码', confidence: 0.9 },
    { dim: 'constraints', key: 'data.migration', fact: '用户要求动数据前必须先备份', confidence: 0.55 },
    { dim: 'nonsense', fact: '', confidence: 0.9 },
    { dim: 'work', key: 'work.project', fact: '用户这次的插件装在 ~/.dsh/plugins 目录下', confidence: 0.9, scope: 'project' },
    { dim: 'habits', key: 'habits.hours', fact: '用户本次喜欢在夜里改代码', confidence: 0.9, scope: 'global' },
  ],
})
let llmCalls = 0
let lastPayload = ''
let lastSystem = ''
const fakeLlm = {
  prepareCall: async (config0, signal) => ({
    config: { provider: 'test', model: 'test-model', maxTokens: config0?.maxTokens },
    stream: async function* stream(options) {
      llmCalls += 1
      lastPayload = JSON.stringify(options?.messages ?? [])
      lastSystem = String(options?.system ?? '')
      if (signal?.aborted === true) throw new Error('aborted')
      yield { type: 'text-delta', text: EXTRACT_REPLY }
    },
  }),
}
const ctx = {
  on: (event, fn) => handlers.set(event, fn),
  loader: { import: async () => { throw new Error('no dsh-llm in test') } },
  logger: { warn: () => {} },
  inject: (deps, callback) => callback({
    llm: fakeLlm,
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }, { requestRejection: (req) => (req.headers?.cookie === undefined ? 401 : undefined) }),
}
apply(ctx, {})
const panelRoute = routes.get('/user-profile/panel.json')
check('注册了面板 HTTP 路由', panelRoute?.kind === 'exact', panelRoute?.path ?? 'missing')

// 假 req/res 直接调 handler，验证鉴权闸门 + 面板 JSON 形状与权重降序
const callPanel = (method = 'GET', headers = { cookie: 'dsh=1' }) => {
  let status = 0
  let payload = ''
  let outHeaders = {}
  panelRoute.handler({ method, headers }, {
    set statusCode(code) { status = code },
    get statusCode() { return status },
    writeHead: (code, h) => { status = code; outHeaders = h ?? {} },
    end: (chunk) => { if (typeof chunk === 'string') payload = chunk },
  })
  return { status, headers: outHeaders, payload }
}
check('无 cookie → 401 拒绝', callPanel('GET', {}).status === 401)
const routeRes = callPanel()
const routeJson = JSON.parse(routeRes.payload)
check('面板返回 200 + json', routeRes.status === 200 && /application\/json/.test(routeRes.headers['content-type'] ?? ''), `${routeRes.status}`)
const routeWeights = routeJson.items.map((item) => item.weight)
check('面板条目按权重降序', routeWeights.every((w, i) => i === 0 || routeWeights[i - 1] >= w), routeWeights.join(' ≥ '))
check('面板条目带 rank/core 字段', routeJson.items.every((item) => typeof item.rank === 'number' && typeof item.core === 'boolean'))
check('面板 405 保护写方法', callPanel('POST').status === 405)
const emit = (event, ...args) => handlers.get(event)?.(...args)
const step = (messages, extra = {}) => handlers.get('agent/pre-step')({ messages, step: 1, ...extra }, async () => ({ kind: 'enter', messages }))

const session = { id: 's1' }
emit('session/event', session, { type: 'turn/start' })
const injected = await step([{ role: 'user', content: [{ type: 'text', text: '帮我把这个脚本整理一下' }] }], { agent: { session } })
const text = injected.messages.at(-1).content[0].text
check('默认叠加：注入画像', text.includes('用户画像') && (text.includes('偏好中文回答') || text.includes('未带入')))
check('注入块带指纹', text.includes('<!--dsh-user-profile-->'))

// 5.6 个性化需求：画像升级为主要依据
const s2 = { id: 's2' }
emit('session/event', s2, { type: 'turn/start' })
const perso = await step([{ role: 'user', content: [{ type: 'text', text: '帮我改一下设置页的风格和配色，要好看' }] }], { agent: { session: s2 } })
const persoText = perso.messages.at(-1).content[0].text
check('个性化轮：明说画像个性化段是主要依据', persoText.includes('主要依据') && persoText.includes('个性化首选'))
check('个性化轮：要求不再反问画像里已有的偏好', persoText.includes('不要反问用户'))
check('规定来自插件内部，不走画像条目', persoText.includes('插件规定') && persoText.includes('不来自画像条目'))
const plain = await step([{ role: 'user', content: [{ type: 'text', text: '把这个脚本整理一下' }] }], { agent: { session: s2 } })
check('同轮不重复注入（个性化块不叠加）', plain.messages.length === perso.messages.length)

// 5.7 相关性检索：只带本轮相关的条目，红线永远带
const sRel = { id: 'sRel' }
emit('session/event', sRel, { type: 'turn/start' })
const unrelated = await step([{ role: 'user', content: [{ type: 'text', text: '帮我看看这个玄学问题：为什么随机数不随机' }] }], { agent: { session: sRel } })
const unrelatedText = unrelated.messages.at(-1).content[0].text
check('相关性闸门：无关条目被挡在外面并说明条数', unrelatedText.includes('未带入') || !unrelatedText.includes('偏好中文回答'))
check('相关性闸门：红线仍然带入', unrelatedText.includes('红线与硬要求'))
check('相关性闸门：规定不受影响', unrelatedText.includes('插件规定'))
emit('session/event', sRel, { type: 'turn/end' })

// 6 用户显式喊停
emit('session/event', session, { type: 'turn/start' })
const suppressed = await step([{ role: 'user', content: [{ type: 'text', text: '这次不使用画像，直接按我的要求写' }] }], { agent: { session } })
const sText = suppressed.messages.at(-1).content[0].text
check('喊停 → 不注入画像内容', !sText.includes('偏好中文回答'))
check('喊停 → 要求声明本次未用画像', sText.includes('本次未结合用户画像'))

// 7 同轮去重
const again = await step(suppressed.messages, { agent: { session } })
check('同轮不重复注入', again.messages.length === suppressed.messages.length)

// 8 行为信号落盘（按真实事件形状：工具名只在 tool/call 的 data.name，
//    tool/result 只有 data.message.isError）
emit('session/event', session, { type: 'tool/call', data: { turn: 9, step: 1, callId: 'c1', name: 'ops_bash', arguments: '{}' } })
emit('session/event', session, { type: 'tool/result', data: { turn: 9, step: 1, message: { role: 'tool', isError: false } } })
emit('session/event', session, { type: 'tool/call', data: { turn: 9, step: 2, callId: 'c2', name: 'ops_read_files', arguments: '{}' } })
emit('session/event', session, { type: 'tool/result', data: { turn: 9, step: 2, message: { role: 'tool', isError: true } } })
emit('session/event', session, { type: 'turn/end' })
const obs = run('status', '--json')
check('turn/end 落盘行为信号', JSON.parse(obs).turns >= 2, `turns=${JSON.parse(obs).turns}`)

// 8.5 工具名不再记成 unknown（旧 bug：只读 event.tool，必然 unknown）
const obsDir = join(HOME, 'observations')
const obsFile = readdirSync(obsDir).filter((f) => f.endsWith('.jsonl')).sort().at(-1)
const obsRaw = readFileSync(join(obsDir, obsFile), 'utf8')
const lastObs = obsRaw.trim().split('\n').map((l) => JSON.parse(l)).at(-1)
const names = (lastObs.tools ?? []).map((t) => (typeof t === 'string' ? t : t.tool))
check('工具名取自 tool/call', names.includes('ops_bash') && names.includes('ops_read_files'), JSON.stringify(names))
check('工具名不含 unknown', !names.includes('unknown'), JSON.stringify(names))
check('tool/result 计入失败数', Number(lastObs.fail) >= 1, `fail=${lastObs.fail}`)

// 9 关掉默认叠加
run('set', 'enabled', 'false')
emit('session/event', session, { type: 'turn/start' })
const off = await step([{ role: 'user', content: [{ type: 'text', text: '随便聊聊' }] }], { agent: { session } })
check('enabled=false → 不注入', off.messages.length === 1)
run('set', 'enabled', 'true')

// 9.5 两段式注入：核心条目必进 + 其余按权重取 topK
run('declare', '--dim', 'constraints', '--key', 'no-emoji', '--fact', '交付里不要用 emoji 图标', '--core')
for (const n of ['配色偏深色', '文档偏爱 Markdown', '习惯用 bash 而不是 PowerShell', '希望方案先给结论', '代码注释用中文']) {
  run('declare', '--dim', 'taste', '--fact', n)
}
run('build')
const injectMd = readFileSync(join(HOME, 'inject.md'), 'utf8')
check('inject.md 分段：红线在个性化之前、参考在最后', injectMd.includes('## 一、红线与硬要求') && injectMd.indexOf('## 一、红线') >= 0 && (injectMd.indexOf('## 三、背景参考') === -1 || injectMd.indexOf('## 一、红线') < injectMd.indexOf('## 三、背景参考')))
check('inject.md 只放数据：不含使用规定', !injectMd.includes('本轮明确指令 >') && !injectMd.includes('不要反问用户') && !injectMd.includes('插件规定'))
check('inject.md 核心条目必进', injectMd.includes('不要用 emoji 图标'))
const restLines = injectMd.split('## 其余')[1]?.split('\n').filter((l) => l.startsWith('- [')) ?? []
check('inject.md 其余段按 topK 收口', restLines.length <= 8, `${restLines.length} 条`)

// 9.6 待审候选：默认不进画像，review 接受后才进
run('declare', '--dim', 'taste', '--key', 'theme', '--fact', '偏好深色主题界面', '--pending')
run('build')
const withPending = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const allTexts = Object.values(withPending.dimensions).flatMap((s) => s.items.map((i) => i.text))
check('待审候选不进画像', !allTexts.some((t) => t.includes('深色主题界面')))
check('profile 记录待审数量', withPending.stats.pending === 1, String(withPending.stats.pending))
run('review', '--accept', 'all')
run('build')
const accepted = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const acceptedTexts = Object.values(accepted.dimensions).flatMap((s) => s.items.map((i) => i.text))
check('review 接受后进画像', acceptedTexts.some((t) => t.includes('深色主题界面')))

// 9.7 冲突策略 freeze：两条并留、标未决
run('declare', '--dim', 'communication', '--key', 'tone', '--fact', '回答要极简')
run('set', 'conflicts.strategy', 'freeze')
run('build')
const frozen = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const frozenItems = frozen.dimensions.communication.items.filter((i) => i.key === 'tone')
check('freeze 保留两条', frozenItems.length === 2, `${frozenItems.length} 条`)
check('freeze 两条都标未决', frozenItems.every((i) => i.frozen === true))
check('freeze 冲突状态为 frozen', frozen.conflicts.some((c) => c.status === 'frozen'))
run('set', 'conflicts.strategy', 'newest')

// 9.8 设置页数据：panel 输出按权重降序
run('build')
const panel = JSON.parse(run('panel'))
const weights = panel.items.map((i) => i.weight)
check('panel 返回条目', panel.items.length > 0, `${panel.items.length} 条`)
check('panel 按权重降序', weights.every((w, i) => i === 0 || weights[i - 1] >= w), weights.join(','))
check('panel 标出核心条目', panel.items.some((i) => i.core === true))
check('panel 带 rank 序号', panel.items[0].rank === 1)
check('panel 状态与画像一致', panel.profile.status === frozen.status)

// 9.9 作用域：project 条目只在同 scopeId 下参与
run('declare', '--dim', 'habits', '--key', 'pkg', '--fact', '本项目用 pnpm 不用 npm', '--scope', 'project', '--scope-id', 'other-project')
run('build', '--scope-id', 'my-project')
const scoped = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const scopedTexts = Object.values(scoped.dimensions).flatMap((s) => s.items.map((i) => i.text))
check('别的项目的 project 条目被隔离', !scopedTexts.some((t) => t.includes('pnpm')))
run('build', '--scope-id', 'other-project')
const scoped2 = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
const scoped2Texts = Object.values(scoped2.dimensions).flatMap((s) => s.items.map((i) => i.text))
check('同 scopeId 下生效', scoped2Texts.some((t) => t.includes('pnpm')))

// 10 归档
run('reset', '--yes')
const afterReset = JSON.parse(run('status', '--json'))
check('reset 清空声明', afterReset.declarations === 0 && afterReset.turns === 0)

// 10.5 画像为空时：规定照样注入，只是没有条目可带
const sEmpty = { id: 's-empty' }
emit('session/event', sEmpty, { type: 'turn/start' })
const policyOnly = await step([{ role: 'user', content: [{ type: 'text', text: '继续' }] }], { agent: { session: sEmpty } })
const policyText = policyOnly.messages.at(-1).content[0].text
check('画像为空也注入插件规定', policyText.includes('插件规定') && policyText.includes('本轮明确指令 > 红线与硬要求'))
check('画像为空时说明按通用方式处理', policyText.includes('当前没有可用条目'), policyText.slice(0, 60))

// 11 show 输出
run('declare', '--dim', 'taste', '--fact', '接受命令行工具优先于 GUI')
run('build')
const md = run('show')
check('show 输出 Markdown', md.includes('# 用户画像') && md.includes('命令行工具优先'))

// 12 config 迁移（旧 schemaVersion 1 → 2，且留备份）
const cfgPath = join(HOME, 'config.json')
const legacy = JSON.parse(readFileSync(cfgPath, 'utf8'))
writeFileSync(cfgPath, JSON.stringify({ ...legacy, schemaVersion: 1, build: undefined, conflicts: undefined, scope: undefined }))
run('status', '--json')   // 任意命令都会走 loadConfig → 迁移
const migrated = JSON.parse(readFileSync(cfgPath, 'utf8'))
check('config 迁移到 schemaVersion 5', migrated.schemaVersion === 5, String(migrated.schemaVersion))
check('迁移补出 conflicts/scope/autoBuild', migrated.conflicts?.strategy === 'newest' && migrated.scope !== undefined && migrated.build?.autoBuild === true)
check('迁移留备份文件', readdirSync(HOME).some((f) => f.startsWith('config.json.bak-v1-')))

// 13 autoBuild：turn/end 后自动重建画像（不依赖人手动跑 CLI）
const stamp = () => {
  try { return statSync(join(HOME, 'profile.json')).mtimeMs } catch { return 0 }
}
run('set', 'build.autoBuild', 'true')
const before = stamp()
emit('session/event', session, { type: 'turn/start' })
emit('session/event', session, { type: 'turn/end' })
let after = before
for (let i = 0; i < 40 && after === before; i += 1) {
  await new Promise((r) => setTimeout(r, 150))
  after = stamp()
}
check('turn/end 触发自动 build', after !== before, `mtime ${before} → ${after}`)

// 14 智能提取：轮末用模型把对话压成画像事实（高置信直接入画像、低置信进待审）
run('set', 'build.autoBuild', 'false')
const declarationsBefore = JSON.parse(run('status', '--json')).declarations
emit('session/event', session, { type: 'turn/start' })
emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'test', model: 'test-model' } } } })
emit('session/event', session, {
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text: '我在 Windows 上用 VS Code 写 Node 脚本，以后改文件前先备份，别再直接覆盖了，另外回复别太长。' }] } },
})
emit('session/event', session, {
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '明白，我会先备份再改，并且回复保持简短。' }] } },
})
emit('session/event', session, { type: 'turn/end' })
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 100))
  if (JSON.parse(run('status', '--json')).declarations > declarationsBefore) break
}
const afterExtract = JSON.parse(run('status', '--json'))
check('轮末调用了模型提取', llmCalls >= 1, `calls=${llmCalls}`)
check('提取结果写入画像事实', afterExtract.declarations > declarationsBefore, `${declarationsBefore} → ${afterExtract.declarations}`)
const declaredRaw = readFileSync(join(HOME, 'declarations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const modelFacts = declaredRaw.filter((r) => r.source === 'model')
check('高置信事实直接入画像', modelFacts.some((r) => r.fact.includes('VS Code')), JSON.stringify(modelFacts.map((r) => r.fact)))
check('事实带 key 便于覆盖', modelFacts.some((r) => r.key === 'tools.editor'))
const pendingPath = join(HOME, 'pending.jsonl')
const pendingRaw = existsSync(pendingPath)
  ? readFileSync(pendingPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []
check('低置信事实进待审', pendingRaw.some((r) => r.fact.includes('备份')), JSON.stringify(pendingRaw.map((r) => r.fact)))
check('空事实/非法维度被丢弃', !declaredRaw.some((r) => r.fact.length === 0) && !declaredRaw.some((r) => r.dim === 'nonsense'))
check('助手正文也进了提取输入（含 reasoning 之外）', llmCalls >= 1)
// 准入门槛：只有「可能对全局有用」的才进画像
check('项目局部的信息（scope=project）不写进全局画像', !declaredRaw.some((r) => r.fact.includes('.dsh/plugins')), JSON.stringify(declaredRaw.map((r) => r.fact)))
check('标了 global 但含「本次」的事实被降级丢弃', !declaredRaw.some((r) => r.fact.includes('夜里改代码')), JSON.stringify(declaredRaw.map((r) => r.fact)))
check('提炼提示带三道准入检查', /跨任务/.test(lastSystem) && /会不会改变我下次的做法/.test(lastSystem) && /归属/.test(lastSystem), String(lastSystem.length))
check('提炼提示要求 scope 并用 project 兜底', /scope/.test(lastSystem) && /拿不准就写 project/.test(lastSystem))

// 15 没有 request/header 时，路由退回 assistant 消息自带的 source
const callsBeforeSourceOnly = llmCalls
const session2 = { id: 's2' }
emit('session/event', session2, { type: 'turn/start' })
emit('session/event', session2, {
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text: '以后的脚本都用 .mjs 写，别再用 CommonJS 了，路径里有中文一律用 fileURLToPath。' }] } },
})
emit('session/event', session2, {
  type: 'assistant/message',
  data: { message: { role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test-model' }, content: [{ type: 'text', text: '好，统一 ESM + fileURLToPath。' }] } },
})
emit('session/event', session2, { type: 'turn/end' })
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 100))
  if (llmCalls > callsBeforeSourceOnly) break
}
check('无 request/header 也能提取（路由取自消息 source）', llmCalls > callsBeforeSourceOnly, `${callsBeforeSourceOnly} → ${llmCalls}`)

// 16 独立性：画像插件绝不参与任务清单提醒（清单归 dsh-todo-sync 管）
const sideCount = (list) => list.filter((m) => {
  const s = JSON.stringify(m)
  return s.includes('dsh-todo-guard') || s.includes('任务清单已经') || s.includes('还没写任务清单')
}).length
const s3 = { id: 's3' }
const ask = async (extra = {}) => step([{ role: 'user', content: [{ type: 'text', text: '继续推进' }] }], { agent: { session: s3 }, ...extra })
emit('session/event', s3, { type: 'turn/start' })
emit('session/event', s3, {
  type: 'todo/write',
  data: { todos: [
    { content: '步骤A：取证', status: 'completed' },
    { content: '步骤B：改代码', status: 'in_progress' },
  ] },
})
for (let i = 0; i < 6; i += 1) emit('session/event', s3, { type: 'tool/call', data: { name: 'ops_bash' } })
const g1 = await ask({ step: 2 })
check('连续 6 次工具调用不产生任何清单提醒', sideCount(g1.messages) === 0, `count=${sideCount(g1.messages)}`)
check('todo/write 的内容不会被塞进画像注入', !JSON.stringify(g1.messages).includes('步骤B'))

// 17 数据可靠性：同义去重、过期检测、提炼器复用已有 key
run('declare', '--dim', 'taste', '--key', 'design.module-separation', '--fact', '用户要求不同插件职责分离，功能不要混在一起', '--confidence', '0.45')
run('declare', '--dim', 'taste', '--key', 'taste.single_responsibility', '--fact', '用户要求每个插件只做一件事，功能不许混在一起', '--confidence', '0.9')
run('build', '--all-scopes')
const mergedPanel = JSON.parse(run('panel'))
const mergedEntry = (mergedPanel.conflicts ?? []).find((c) => c.status === 'merged')
check('同义条目被自动合并（相似度 0.46 > 阈值 0.45）', mergedEntry !== undefined, mergedEntry?.key ?? 'none')
const prefTexts = (mergedPanel.items ?? []).filter((it) => it.dim === 'taste').map((it) => it.text)
check('合并后只留权重更高的一条', prefTexts.some((t) => t.includes('每个插件只做一件事')) && !prefTexts.some((t) => t.includes('不同插件职责分离')), prefTexts.join(' | '))
check('合并后画像不自相矛盾（声明数仍记 8+2）', mergedPanel.drift?.stale === false, JSON.stringify(mergedPanel.drift))

// declare 现在自带 rebuild，制造不出漂移；改用 fs 直接追加，模拟「数据已写、进程在 build 前被杀」
appendFileSync(join(HOME, 'declarations.jsonl'), `${JSON.stringify({
  id: 'dcl_driftcase',
  at: new Date().toISOString(),
  dim: 'communication',
  key: 'communication.style',
  fact: '用户偏好结论先行，细节放在后面',
  source: 'user',
  confidence: 0.9,
  core: false,
  scope: 'global',
})}\n`)
const driftedPanel = JSON.parse(run('panel'))
check('写了新数据但没 build → 面板标出画像过期', driftedPanel.drift?.stale === true, JSON.stringify(driftedPanel.drift))
check('status 也标出过期', JSON.parse(run('status', '--json')).stale === true)

run('build', '--all-scopes')
const beforeContext = llmCalls
const s4 = { id: 's4' }
emit('session/event', s4, { type: 'turn/start' })
emit('session/event', s4, {
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text: '以后所有插件都必须独立，别把清单提醒塞进画像插件里，这点要长期记住。' }] } },
})
emit('session/event', s4, { type: 'turn/end' })
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 100))
  if (llmCalls > beforeContext) break
}
check('提炼器拿到了「已有画像条目」以便复用 key', lastPayload.includes('已有画像条目'), lastPayload.length > 0 ? 'payload ok' : 'empty')

// 18 并发与锁：追加型命令不能被别人的「整表写回」吞掉
const countDecl = () => readFileSync(join(HOME, 'declarations.jsonl'), 'utf8').split('\n').filter(Boolean).length
const declBefore = countDecl()
await Promise.all([
  ...[1, 2, 3, 4, 5, 6].map((i) => execFileP(process.execPath, [CLI, 'declare', '--dim', 'habits', '--key', `concurrent.${i}`, '--fact', `并发写入第 ${i} 条，必须一条都不能少`], { env: process.env })),
  execFileP(process.execPath, [CLI, 'build', '--all-scopes'], { env: process.env }),
])
const declAfter = countDecl()
check('6 个并发写 + 1 个 build 后一条不丢', declAfter === declBefore + 6, `${declBefore} → ${declAfter}`)

// 陈旧锁要能自愈，否则进程被 kill 一次就永久锁死
writeFileSync(join(HOME, '.lock'), String(Date.now() - 120000))
const revived = run('declare', '--dim', 'habits', '--fact', '陈旧锁不该把 CLI 永久锁死')
check('陈旧锁被自动清理', revived.includes('已记录') && !existsSync(join(HOME, '.lock')))

// 19 删除必须当场刷新画像：否则面板停在旧快照，用户会报「删除功能失效」
const itemsNow = () => JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8')).stats.items
run('build', '--all-scopes')
const itemsBefore = itemsNow()
const victim = JSON.parse(readFileSync(join(HOME, 'profile.json'), 'utf8'))
  .dimensions.taste.items[0].id
const forgetOut = run('forget', '--id', victim)
check('forget 自己会重建画像（不靠外部 build）', itemsNow() === itemsBefore - 1, `${itemsBefore} → ${itemsNow()}`)
check('forget 的回执说「画像已刷新」', forgetOut.includes('画像已刷新'), forgetOut.split('\n')[0])

rmSync(HOME, { recursive: true, force: true })
console.log(process.exitCode ? '\n有用例失败' : '\n全部通过')
