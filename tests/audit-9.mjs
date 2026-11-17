// 第九轮排查：专测 v25.1 之后的「相关性闸门 ↔ explain 一致性」与新增配置/迁移路径。
// 判据：面板/CLI 说会带入的，注入时必须真的带入；反过来也一样。
// 全部在临时 HOME 里跑，不碰真实画像。跑法：node _audit9.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-up-a9-'))
process.env.DSH_USER_PROFILE_HOME = HOME
process.env.DSH_PROFILE_DIAG = '0'

const { apply } = await import(`file://${join(HERE, 'index.js').replace(/\\/g, '/')}`)

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; return }
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}
function cli(args) {
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env, timeout: 30000 })
  return { code: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}
function json(args) {
  const r = cli(args)
  try { return { ...r, data: JSON.parse(r.stdout) } } catch { return { ...r, data: null } }
}
const readJson = (name) => JSON.parse(readFileSync(join(HOME, name), 'utf8'))

// 造一个 8 条的画像：4 条 taste/communication 带「宣传片/配音/界面」线索，4 条与查询无关
cli(['init'])
const seed = [
  ['taste', '用户要求对外宣传内容面向零基础普通观众，不出现代码和术语', 0.8],
  ['taste', '用户要求插件界面像成熟产品：有层次、有留白', 0.9],
  ['communication', '用户用短句直接指出问题，期待结论、证据和下一步', 0.8],
  ['habits', '用户要求功能真机跑通、实际点击并核对落盘', 0.9],
  ['identity', '用户是本科在读学生，在学高等数学与 C 语言', 0.9],
  ['interests', '用户长期关注无人机执照与空域考试', 0.7],
  ['goals', '用户在准备正大杯与阿里天池竞赛', 0.7],
  ['social', '用户会把自己的工具项目发布到 GitHub 公开分享', 0.45],
]
for (const [dim, fact, confidence] of seed) {
  cli(['declare', '--dim', dim, '--fact', fact, '--confidence', String(confidence), '--force', '--no-merge'])
}
cli(['build'])

const injectionFor = async (text) => {
  const handlers = new Map()
  const ctx = { on: (topic, fn) => handlers.set(topic, fn), inject: (deps, cb) => cb({}), loader: {} }
  apply(ctx, {})
  const session = { id: `a9-${Math.random().toString(36).slice(2)}` }
  handlers.get('session/event')(session, { type: 'turn/start' })
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text }] }] }
  const result = await handlers.get('agent/pre-step')({ agent: { session }, messages: decision.messages, step: 1 }, async () => decision)
  const block = (result?.messages ?? [])
    .map((m) => (Array.isArray(m.content) ? m.content.map((part) => part?.text ?? '').join('\n') : String(m.content ?? '')))
    .join('\n')
  const idx = block.indexOf('## 保底带入')
  const filled = idx < 0 ? 0 : (block.slice(idx).match(/^- \[/gm) || []).length
  return { block, entries: (block.match(/^- \[/gm) || []).length, filled }
}

// ---- A 段：explain 与实际注入必须说同一件事 ----
{
  const queries = ['给宣传片换个配音', '这个是对的，继续', '帮我看看这个玄学问题：为什么随机数不随机']
  for (const query of queries) {
    const explained = json(['explain', query, '--json']).data
    const injected = await injectionFor(query)
    const carried = explained?.carried?.length ?? -1
    check(`explain 与注入一致：${query}`, carried === injected.entries, `explain 说带入 ${carried} 条，实际注入 ${injected.entries} 条`)
  }
}

// ---- B 段：保底闸门的边界 ----
{
  process.env.DSH_PROFILE_MIN_KEEP = '不是数字'
  const bad = await injectionFor('继续')
  check('MIN_KEEP 写坏不等于崩溃、也不会把画像清空', bad.entries > 0, `entries=${bad.entries}`)
  delete process.env.DSH_PROFILE_MIN_KEEP

  process.env.DSH_PROFILE_MIN_KEEP = '3'
  const three = await injectionFor('继续')
  check('MIN_KEEP=3 时保底只补到 3 条（可调）', three.filled === 3, `filled=${three.filled}（红线段不计入保底）`)
  delete process.env.DSH_PROFILE_MIN_KEEP
}

// ---- C 段：dedupe 的错误路径 ----
{
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-up-a9-empty-'))
  const saved = process.env.DSH_USER_PROFILE_HOME
  process.env.DSH_USER_PROFILE_HOME = fresh
  const empty = json(['dedupe', '--pairs'])
  process.env.DSH_USER_PROFILE_HOME = saved
  check('空库 dedupe --pairs 返回空数组而不是报错', empty.code === 0 && empty.data?.count === 0, `code=${empty.code} count=${empty.data?.count}`)
  const badPair = cli(['dedupe', '--apply-pairs', 'no-such-id|also-missing'])
  check('apply-pairs 指向不存在的 id 必须非零退出', badPair.code !== 0)
  check('apply-pairs 失败时给人话而不是堆栈', /找不到|不存在|没有匹配|没有能匹配/.test(`${badPair.stdout}${badPair.stderr}`), (badPair.stderr || badPair.stdout).slice(0, 80))
}

// ---- D 段：--pending 不该被写入端合并吞掉 ----
{
  cli(['declare', '--dim', 'taste', '--fact', '用户要求界面像成熟产品：有层次、有留白', '--force', '--no-merge'])
  const before = json(['panel']).data?.pending?.length ?? 0
  cli(['declare', '--dim', 'taste', '--fact', '用户要求界面像成熟产品，有层次有留白', '--pending', '--force'])
  const after = json(['panel']).data?.pending?.length ?? 0
  check('--pending 走候选队列，不被合并进已有条目', after === before + 1, `${before} → ${after}`)
}

// ---- E 段：v5 → v6 配置迁移（旧默认 0.45 要变成 0.35） ----
{
  const file = join(HOME, 'config.json')
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  cfg.schemaVersion = 5
  cfg.build = { ...(cfg.build ?? {}), similarityThreshold: 0.45 }
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  const r = json(['panel'])
  check('v5 配置被迁移到 v6', readJson('config.json').schemaVersion === 6, String(readJson('config.json').schemaVersion))
  check('旧默认 0.45 被迁到 0.35', readJson('config.json').build.similarityThreshold === 0.35, String(readJson('config.json').build.similarityThreshold))
  check('迁移后面板能正常读', r.data?.ok === true)
}

// ---- F 段：ingest → dedupe（跨类同义也要能并） ----
{
  const text = '- 用户的界面审美偏冷色调、低饱和'
  const ing = json(['ingest', '--text', text, '--source', 'ChatGPT', '--apply'])
  check('ingest 能写入', ing.code === 0 && /可写入|已写入/.test(`${ing.stdout}`), ing.stdout.slice(0, 80))
  cli(['declare', '--dim', 'taste', '--fact', '用户界面审美偏冷色调低饱和', '--force', '--no-merge'])
  const pairs = json(['dedupe', '--pairs'])
  const anyPair = (pairs.data?.pairs ?? []).some((p) => /冷色调/.test(p.a.fact) && /冷色调/.test(p.b.fact))
  check('dedupe --pairs 能识别这对近义条目', anyPair, `count=${pairs.data?.count}`)
}

// ---- G 段：新配置键真的可读可写 ----
{
  const s = json(['panel']).data?.settings ?? {}
  check('面板暴露 autoMergeSemantic', s.build?.autoMergeSemantic !== undefined)
  check('面板暴露 semanticMergeIntervalMs', s.build?.semanticMergeIntervalMs !== undefined)
  const set = cli(['set', 'build.semanticMergeIntervalMs', '600000'])
  check('semanticMergeIntervalMs 可写', set.code === 0, set.stderr.slice(0, 80))
  check('写入后读得回来', json(['panel']).data?.settings?.build?.semanticMergeIntervalMs === 600000)
  const bad = cli(['set', 'build.semanticMergeIntervalMs', 'abc'])
  check('非法值被拒', bad.code !== 0)
}

console.log(`\n第九轮排查：通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { for (const f of failures) console.log(` - ${f}`); process.exit(1) }
