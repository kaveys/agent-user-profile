// 端到端功能自检：把插件当成黑盒，一条条真调。
// 分两段：
//   A 段 = 隔离数据目录跑全部 CLI 子命令（不碰真实画像）
//   B 段 = 打真实运行中的面板路由（GET 面板 + POST 12 个动作 + 错误分支），结束时清掉测试痕迹
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const HERE = process.cwd()
const CLI = join(HERE, 'bin', 'profile.mjs')
const NODE = process.execPath
const HOME_DIR = join(homedir(), '.dsh', 'user-profile')
const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:37442'

let pass = 0
const fails = []
const results = []
function t(name, fn) {
  try {
    fn()
    pass += 1
    results.push(['PASS', name, ''])
  } catch (error) {
    fails.push(`${name} :: ${error?.message ?? error}`)
    results.push(['FAIL', name, String(error?.message ?? error).slice(0, 160)])
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label ?? '值不匹配'}：期望 ${b}，实际 ${a}`)
}
function ok(cond, label) { if (!cond) throw new Error(label ?? '断言失败') }

// ---------- A 段：隔离目录 ----------
const box = mkdtempSync(join(tmpdir(), 'dsh-profile-e2e-'))
const env = { ...process.env, DSH_USER_PROFILE_HOME: box }
function cli(args, opts = {}) {
  const run = spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, cwd: box })
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`, stdout: run.stdout ?? '' }
}
function cliOk(args) {
  const r = cli(args)
  if (r.code !== 0) throw new Error(`\`${args.join(' ')}\` 退出码 ${r.code}：${r.out.trim().slice(0, 200)}`)
  return r
}
const readJsonl = (name) => (existsSync(join(box, name))
  ? readFileSync(join(box, name), 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
  : [])

t('init 建出配置与目录', () => {
  cliOk(['init'])
  for (const f of ['config.json', 'declarations.jsonl', 'pending.jsonl', 'changelog.jsonl']) {
    ok(existsSync(join(box, f)), `缺少 ${f}`)
  }
  eq(JSON.parse(readFileSync(join(box, 'config.json'), 'utf8')).schemaVersion, 5, 'schemaVersion')
})

t('declare 写入一条声明并自带重建', () => {
  cliOk(['declare', '--dim', 'identity', '--fact', '用户是 E2E 测试账号', '--confidence', '0.9', '--core'])
  eq(readJsonl('declarations.jsonl').length, 1, '声明条数')
  ok(existsSync(join(box, 'profile.json')), '画像未生成')
})

t('declare --pending 进待审而不进画像', () => {
  cliOk(['declare', '--dim', 'taste', '--fact', '用户偏爱深色界面', '--confidence', '0.45', '--pending'])
  eq(readJsonl('pending.jsonl').length, 1, '待审条数')
  eq(readJsonl('declarations.jsonl').length, 1, '声明不应增加')
})

t('edit --weight 改权重（面板「权重」列走这条）', () => {
  const target = readJsonl('declarations.jsonl').find((r) => r.fact.includes('E2E 测试账号'))
  cliOk(['edit', '--id', target.id, '--weight', '0.75'])
  const after = readJsonl('declarations.jsonl').find((r) => r.id === target.id)
  eq(after.confidence, 0.75, '权重应写入 confidence')
  cliOk(['edit', '--id', target.id, '--weight', '0.9'])
  eq(readJsonl('declarations.jsonl').find((r) => r.id === target.id).confidence, 0.9, '权重可反复调整')
})

t('declare --scope project 只在当前工作区生效', () => {
  cliOk(['declare', '--dim', 'habits', '--fact', '这个仓库统一用 pnpm 装依赖', '--scope', 'project'])
  const rows = readJsonl('declarations.jsonl')
  const scoped = rows.filter((r) => r.scope === 'project')
  eq(scoped.length, 1, 'project 作用域条数')
  ok(typeof scoped[0].scopeId === 'string' && scoped[0].scopeId.length > 0, 'project 条目必须带 scopeId')
  const globalCount = rows.filter((r) => r.scope === 'global').length
  eq(globalCount, 1, '全局条目不该被 project 影响')
  cliOk(['forget', '--id', scoped[0].id])
  eq(readJsonl('declarations.jsonl').length, 1, '清理后回到 1 条')
})

t('review 列出、接受、丢弃', () => {
  const listed = cliOk(['review']).out
  ok(listed.includes('待审候选 1 条'), '列表文案')
  const id = readJsonl('pending.jsonl')[0].id
  cliOk(['review', '--accept', id])
  eq(readJsonl('declarations.jsonl').length, 2, '接受后声明数')
  eq(readJsonl('pending.jsonl').length, 0, '待审应清空')
  cliOk(['declare', '--dim', 'taste', '--fact', '用户讨厌荧光绿', '--pending'])
  cliOk(['review', '--reject', 'all'])
  eq(readJsonl('declarations.jsonl').length, 2, '丢弃后声明数不变')
  eq(readJsonl('pending.jsonl').length, 0, '丢弃后待审清空')
})

t('edit 改内容/维度/置信度', () => {
  const id = readJsonl('declarations.jsonl')[0].id
  cliOk(['edit', '--id', id, '--dim', 'work', '--fact', '用户在做 E2E 测试', '--confidence', '0.6'])
  const record = readJsonl('declarations.jsonl').find((r) => r.id === id)
  eq([record.dim, record.confidence], ['work', 0.6], '字段')
  ok(record.history === undefined || record.history.length === 0, '编辑不应产生冲突历史')
})

t('merge 把一条并进另一条', () => {
  cliOk(['declare', '--dim', 'taste', '--fact', '用户要求界面高度可自定义', '--key', 'taste.custom'])
  const all = readJsonl('declarations.jsonl')
  const keep = all.find((r) => r.key === 'taste.custom').id
  const drop = all.find((r) => r.id !== keep).id
  cliOk(['merge', '--keep', keep, '--drop', drop])
  const after = readJsonl('declarations.jsonl')
  eq(after.length, all.length - 1, '并掉一条')
  ok((after.find((r) => r.id === keep).mergedFrom ?? []).length === 1, 'mergedFrom 未记录')
})

t('forget 支持 --id / --key / --dim / --all', () => {
  const all = readJsonl('declarations.jsonl')
  cliOk(['forget', '--id', all[0].id])
  eq(readJsonl('declarations.jsonl').length, all.length - 1, '--id')
  cliOk(['declare', '--dim', 'goals', '--fact', '用户想在周五前交付', '--key', 'goals.deadline'])
  cliOk(['forget', '--key', 'goals.deadline'])
  eq(readJsonl('declarations.jsonl').filter((r) => r.key === 'goals.deadline').length, 0, '--key')
  const before = readJsonl('declarations.jsonl').length
  cliOk(['declare', '--dim', 'goals', '--fact', '用户想在下周继续', '--key', 'goals.next'])
  cliOk(['forget', '--dim', 'goals'])
  eq(readJsonl('declarations.jsonl').length, before, '--dim')
})

t('forget 无匹配时报错而不是静默成功', () => {
  const r = cli(['forget', '--id', 'dcl_not_exist'])
  ok(r.code !== 0, '应非零退出')
  ok(r.out.includes('没有匹配'), `文案：${r.out.trim().slice(0, 80)}`)
})

t('import 吃 JSON 数组与 JSONL 快照', () => {
  const file = join(box, 'seed.json')
  writeFileSync(file, JSON.stringify({ items: [
    { dim: 'skills', fact: '用户会用 Python 写脚本', confidence: 0.6 },
    { dim: 'bad-dim', fact: '维度非法的这条应被跳过', confidence: 0.6 },
  ] }), 'utf8')
  const before = readJsonl('declarations.jsonl').length
  const r = cliOk(['import', '--file', file])
  ok(r.out.includes('跳过') || r.out.includes('导入'), `回执：${r.out.trim().slice(0, 80)}`)
  eq(readJsonl('declarations.jsonl').length, before + 1, '只导入了合法那条')

  const snap = join(box, 'snap.jsonl')
  writeFileSync(snap, [
    JSON.stringify({ dim: 'habits', fact: '用户习惯晚上写代码', confidence: 0.6 }),
    JSON.stringify({ dim: 'preferences', fact: '老维度名应被重归类', confidence: 0.6 }),
  ].join('\n'), 'utf8')
  cliOk(['import', '--file', snap])
  const dims = readJsonl('declarations.jsonl').map((r) => r.dim)
  ok(dims.includes('habits'), 'JSONL 未导入')
  ok(!dims.includes('preferences'), '老维度名未重归类')
})

t('dims list / add / remove / reclassify', () => {
  ok(cliOk(['dims']).out.includes('画像大类'), 'list 文案')
  cliOk(['dims', 'add', 'tooling', '工具链'])
  ok(JSON.parse(readFileSync(join(box, 'config.json'), 'utf8')).dimensions.includes('tooling'), '维度未写入')
  cliOk(['dims', 'remove', 'tooling'])
  ok(!JSON.parse(readFileSync(join(box, 'config.json'), 'utf8')).dimensions.includes('tooling'), '维度未移除')
  const r = cli(['dims', 'add', 'Bad-ID', 'x'])
  ok(r.code !== 0, '非法 id 应报错')
  cliOk(['dims', 'reclassify'])
})

t('observe 记录一轮运行观测', () => {
  cliOk(['observe', '--tools', 'read,edit', '--steps', '2', '--scope', 'global'])
  const month = new Date().toISOString().slice(0, 7)
  const obsFile = join(box, 'observations', `${month}.jsonl`)
  ok(existsSync(obsFile), '观测文件未生成')
  ok(readFileSync(obsFile, 'utf8').includes('"kind":"turn"'), '观测记录形状')
})

t('build 产出 profile.json / profile.md / inject.md', () => {
  cliOk(['build', '--all-scopes'])
  for (const f of ['profile.json', 'profile.md', 'inject.md']) ok(existsSync(join(box, f)), `缺少 ${f}`)
  const inject = readFileSync(join(box, 'inject.md'), 'utf8')
  ok(inject.includes('# 用户画像'), '注入块缺标题')
  ok(!inject.includes('使用顺序'), '注入块不该再带使用规矩')
})

t('show / status / panel 三种读法都可用', () => {
  ok(cliOk(['show']).out.includes('用户画像'), 'show')
  const s = cliOk(['status']).out
  ok(s.includes('默认叠加') && s.includes('画像'), 'status 字段')
  const panel = JSON.parse(cliOk(['panel']).stdout)
  for (const key of ['ok', 'config', 'profile', 'items', 'conflicts', 'pending', 'settings', 'stats', 'snapshots', 'dimensions']) {
    ok(key in panel, `panel 缺 ${key}`)
  }
  ok(!('paths' in panel), 'panel 不该再带 paths')
})

t('set 改配置项并落盘', () => {
  cliOk(['set', 'inject.maxChars', '900'])
  cliOk(['set', 'conflicts.strategy', 'freeze'])
  const config = JSON.parse(readFileSync(join(box, 'config.json'), 'utf8'))
  eq([config.inject.maxChars, config.conflicts.strategy], [900, 'freeze'], '配置值')
})

t('snapshots / restore 能整批回滚', () => {
  const before = readJsonl('declarations.jsonl').length
  cliOk(['declare', '--dim', 'taste', '--fact', '用户要一份备份', '--pending'])
  cliOk(['forget', '--all'])
  eq(readJsonl('declarations.jsonl').length, 0, '全删')
  const list = cliOk(['snapshots']).out
  ok(list.includes('declarations-'), '快照列表')
  const name = readdirSync(join(box, 'snapshots')).filter((f) => f.endsWith('.jsonl')).sort().pop()
  cliOk(['restore', '--name', name])
  ok(readJsonl('declarations.jsonl').length > 0, '恢复后应为非空')
  ok(readJsonl('declarations.jsonl').length >= Math.min(before, 1), '恢复条数')
})

t('export 导出到指定目录', () => {
  const out = join(box, 'exp')
  cliOk(['export', '--out', out])
  ok(existsSync(join(out, 'profile.json')) || readdirSync(out).length > 0, '导出目录为空')
})

// ---- v15：有效性闸门 / 脱敏 / 溯源 / 备份 / MCP ----

t('validate 只报告不改数据', () => {
  const before = readJsonl('declarations.jsonl').length
  cliOk(['declare', '--dim', 'taste', '--fact', '用户偏好结论先行，再给证据', '--confidence', '0.9'])
  const r = cliOk(['validate'])
  ok(r.out.includes('不合格 0 条'), `回执：${r.out.trim().slice(0, 120)}`)
  ok(readJsonl('declarations.jsonl').length === before + 1, 'validate 不该改数据')
})

t('本次任务细节被有效性闸门拒绝', () => {
  const r = cli(['declare', '--dim', 'taste', '--fact', '本次任务要改 client.js 的按钮'])
  ok(r.code !== 0, '应非零退出')
  ok(/本次任务的细节|不合格/.test(r.out), `文案：${r.out.trim().slice(0, 120)}`)
})

t('declare 落盘前自动脱敏并记溯源', () => {
  cliOk(['declare', '--dim', 'identity', '--fact', '用户电话 13800138000，邮箱 me@example.com', '--excerpt', '我电话是 13800138000'])
  const record = readJsonl('declarations.jsonl').find((row) => (row.fact ?? '').includes('⟨手机号⟩'))
  ok(record !== undefined, '没找到脱敏后的记录')
  ok(!record.fact.includes('13800138000'), '手机号没被替换')
  ok(record.provenance?.excerpt === '我电话是 13800138000', '溯源摘录丢了')
  const panel = JSON.parse(cliOk(['panel']).stdout)
  ok(panel.items.some((item) => item.provenance?.excerpt === '我电话是 13800138000'), 'panel 未透出 provenance')
})

t('redact 默认只统计，--apply 才写回', () => {
  appendFileSync(
    join(box, 'declarations.jsonl'),
    `${JSON.stringify({ id: 'dcl_manual_leak', at: new Date().toISOString(), dim: 'identity', key: 'identity.leak', fact: '用户备用手机 13900139000', source: 'user', confidence: 0.5 })}\n`,
  )
  const scan = cliOk(['redact'])
  ok(/1 条/.test(scan.out), `扫描回执：${scan.out.trim().slice(0, 120)}`)
  ok(readJsonl('declarations.jsonl').some((row) => row.id === 'dcl_manual_leak' && row.fact.includes('13900139000')), '扫描不该改数据')
  cliOk(['redact', '--apply'])
  const after = readJsonl('declarations.jsonl').find((row) => row.id === 'dcl_manual_leak')
  ok(after === undefined || !after.fact.includes('13900139000'), '--apply 后仍残留手机号')
})

t('backup --out 导出可回灌的备份包', () => {
  const dir = join(box, 'backup')
  cliOk(['backup', '--out', dir])
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  ok(files.length > 0, '备份包未生成')
  const bundle = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
  ok(bundle.kind === 'dsh-user-profile-backup', '备份包 kind 不对')
  ok(Array.isArray(bundle.declarations) && bundle.declarations.length > 0, '备份包没带条目')
  ok(bundle.config?.backup?.webdav?.passwordEnv !== undefined, '备份包缺配置快照')
})

t('未配 WebDAV 时 backup 明确报错而不是假装成功', () => {
  const r = cli(['backup', '--dry-run'])
  ok(r.code !== 0, '应非零退出')
  ok(/WebDAV|backup.webdav/.test(r.out), `文案：${r.out.trim().slice(0, 140)}`)
})

t('MCP server 能被宿主握手并调用工具', () => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'profile_search', arguments: { query: '结论先行' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'user-profile://portrait' } }),
  ].join('\n')
  const run = spawnSync(NODE, [join(HERE, 'mcp', 'server.mjs')], { encoding: 'utf8', env, input: `${lines}\n` })
  ok(run.status === 0, `退出码 ${run.status}`)
  const replies = run.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  ok(replies.length === 4, `应只有 4 条回包（通知不该回）：${replies.length}`)
  ok(replies[0].result.serverInfo.name === 'agent-user-profile', 'serverInfo')
  ok(replies[1].result.tools.length >= 10, `工具数 ${replies[1].result.tools.length}`)
  ok(replies[2].result.content[0].text.includes('结论先行'), 'search 未命中')
  ok(replies[3].result.contents[0].text.includes('# 用户画像'), '资源未返回画像')
})

t('reset 归档并清空', () => {
  cliOk(['reset', '--yes'])
  eq(readJsonl('declarations.jsonl').length, 0, '声明应清空')
  ok(readdirSync(join(box, 'archive')).length > 0, '归档未生成')
})

// ---------- B 段：真实面板路由 ----------
async function http(path, init) {
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, text }
}
const post = (body) => http('/user-profile/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// B 段要打运行中的宿主。CI 里没有宿主：--cli-only 显式跳过，
// 探不到端口时也自动跳过（否则 CI 会红在一个跟代码无关的地方）。
const CLI_ONLY = process.argv.includes('--cli-only')
if (CLI_ONLY) {
  console.log(`\n[A 段] 通过 ${pass} 项，失败 ${fails.length} 项（--cli-only：跳过 HTTP 段）`)
  if (fails.length) { for (const f of fails) console.log(' - ' + f); process.exitCode = 1 }
  process.exit(process.exitCode ?? 0)
}
try {
  const probe = await fetch(`${BASE}/user-profile/panel.json`)
  if (!probe.ok && probe.status !== 401) throw new Error(`status ${probe.status}`)
} catch (error) {
  console.log(`\n[A 段] 通过 ${pass} 项，失败 ${fails.length} 项`)
  console.log(`跳过 B 段（HTTP）：${BASE} 不可达（${error?.message ?? error}）`)
  if (fails.length) { for (const f of fails) console.log(' - ' + f); process.exitCode = 1 }
  process.exit(process.exitCode ?? 0)
}

const baseline = existsSync(join(HOME_DIR, 'declarations.jsonl'))
  ? readFileSync(join(HOME_DIR, 'declarations.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length
  : 0
const marker = `e2e-${Date.now()}`

const checks = []
async function at(name, fn) {
  try {
    await fn()
    pass += 1
    results.push(['PASS', name, ''])
  } catch (error) {
    fails.push(`${name} :: ${error?.message ?? error}`)
    results.push(['FAIL', name, String(error?.message ?? error).slice(0, 160)])
  }
}

await at('GET /user-profile/panel.json 返 200 且结构完整', async () => {
  const r = await http('/user-profile/panel.json')
  eq(r.status, 200, '状态码')
  for (const key of ['ok', 'config', 'profile', 'items', 'settings', 'stats', 'snapshots']) ok(key in r.json, `缺 ${key}`)
})

await at('POST build', async () => {
  const r = await post({ action: 'build' })
  eq(r.status, 200, '状态码')
  eq(r.json.ok, true, 'ok')
})

await at('POST declare（新增自定义条目）', async () => {
  const r = await post({ action: 'declare', dim: 'taste', fact: `用户正在做功能自检 ${marker}`, key: `taste.${marker}` })
  eq(r.json?.ok, true, `ok=${JSON.stringify(r.json).slice(0, 120)}`)
})

await at('POST edit（改刚建的那条）', async () => {
  const panel = await http('/user-profile/panel.json')
  const item = (panel.json.items ?? []).find((i) => (i.key ?? '').includes(marker))
  ok(item !== undefined, '找不到测试条目')
  const r = await post({ action: 'edit', id: item.id, fact: `用户已完成功能自检 ${marker}`, confidence: 0.6 })
  eq(r.json?.ok, true, 'ok')
})

await at('POST review（无候选时给出提示而非报错）', async () => {
  const r = await post({ action: 'review', accept: 'all' })
  ok(r.json?.ok === true || /没有匹配|没有待审/.test(r.json?.error ?? r.json?.output ?? ''), `回执：${JSON.stringify(r.json).slice(0, 140)}`)
})

await at('POST set（改一项配置）', async () => {
  const r = await post({ action: 'set', key: 'inject.maxChars', value: 1600 })
  eq(r.json?.ok, true, 'ok')
})

await at('POST settings（批量保存 + 重建）', async () => {
  const r = await post({ action: 'settings', entries: { 'inject.topK': 8 } })
  eq(r.json?.ok, true, `ok=${JSON.stringify(r.json).slice(0, 140)}`)
})

await at('POST dims add / remove', async () => {
  const add = await post({ action: 'dims', add: true, id: 'e2edim', label: '自检维度' })
  eq(add.json?.ok, true, 'add')
  const remove = await post({ action: 'dims', remove: true, id: 'e2edim' })
  eq(remove.json?.ok, true, 'remove')
})

await at('POST importText（批量导入）', async () => {
  const r = await post({ action: 'importText', items: [{ dim: 'goals', fact: `导入自检条目 ${marker}`, confidence: 0.6 }] })
  eq(r.json?.ok, true, `ok=${JSON.stringify(r.json).slice(0, 140)}`)
})

await at('POST merge（把导入那条并进目标）', async () => {
  const panel = await http('/user-profile/panel.json')
  const items = panel.json.items ?? []
  const drop = items.find((i) => i.text.includes('导入自检条目'))
  const keep = items.find((i) => i.text.includes('已完成功能自检'))
  ok(drop !== undefined && keep !== undefined, '找不到合并所需的条目')
  const r = await post({ action: 'merge', keep: keep.id, drop: drop.id })
  eq(r.json?.ok, true, 'ok')
})

await at('POST export（导出快照）', async () => {
  const r = await post({ action: 'export', out: join(tmpdir(), `dsh-profile-e2e-export-${Date.now()}`) })
  eq(r.json?.ok, true, 'ok')
})

await at('POST restore（非法名被挡）', async () => {
  const r = await post({ action: 'restore', name: '../../etc/passwd' })
  ok(r.json?.ok === false, '应拒绝')
})

await at('POST reset（缺 confirm 被挡）', async () => {
  const r = await post({ action: 'reset' })
  ok(r.json?.ok === false, '应拒绝')
})

await at('POST 未知动作返 400', async () => {
  const r = await post({ action: 'nope' })
  eq(r.status, 400, '状态码')
})

await at('POST forget（清掉自检条目）', async () => {
  const r = await post({ action: 'forget', key: `taste.${marker}` })
  ok(r.json?.ok === true || /没有匹配/.test(r.json?.error ?? ''), JSON.stringify(r.json).slice(0, 120))
})

await at('清理后条目数与自检前一致', async () => {
  await post({ action: 'build' })
  const panel = await http('/user-profile/panel.json')
  const left = (panel.json.items ?? []).filter((i) => i.text.includes(marker) || i.text.includes('导入自检'))
  eq(left.length, 0, `残留 ${left.length} 条`)
  const now = (panel.json.stats ?? {}).items
  ok(Math.abs(now - baseline) <= 1, `条目数 ${now}，自检前 ${baseline}`)
})

rmSync(box, { recursive: true, force: true })

// ---------- 汇总 ----------
const width = Math.max(...results.map((r) => r[1].length)) + 2
for (const [state, name, detail] of results) {
  process.stdout.write(`${state === 'PASS' ? '  PASS' : '  FAIL'}  ${name.padEnd(width)}${detail ? `  ${detail}` : ''}\n`)
}
process.stdout.write(`\n${pass} / ${pass + fails.length} 项通过\n`)
if (fails.length > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const f of fails) process.stdout.write(`  - ${f}\n`)
  process.exit(1)
}
