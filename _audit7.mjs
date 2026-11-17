// 第七轮排查：专测「从别的 AI 搬回画像」（ingest）的语义。
// 全部在临时 HOME 里跑，不碰真实画像。跑法：node _audit7.mjs
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'bin', 'profile.mjs')
const MCP = join(HERE, 'mcp', 'server.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-up-a7-'))
process.env.DSH_USER_PROFILE_HOME = HOME
process.env.DSH_PROFILE_DIAG = '0'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; return }
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}
function cli(args) {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: process.env,
    timeout: 30000,
  })
  return { code: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}
function json(args) {
  const r = cli(args)
  try { return { ...r, data: JSON.parse(r.stdout) } } catch { return { ...r, data: null } }
}
function sample(name, body) {
  const file = join(HOME, `${name}.txt`)
  writeFileSync(file, body, 'utf8')
  return file
}

cli(['init'])

// ---- A 段：预览不写库、apply 才写 ----
{
  const file = sample('a', [
    '以下是我了解到的关于你的信息：',
    '- 你是一名本科生',
    '- 你希望回答简短，不要废话',
  ].join('\n'))
  const preview = cli(['ingest', '--file', file, '--source', 'ChatGPT'])
  check('A1 预览能认出条目并明确说「加 --apply」', preview.code === 0 && /--apply/.test(preview.stdout), preview.stdout.slice(0, 80))
  check('A2 预览没有写库', json(['panel']).data?.stats?.items === 0, String(json(['panel']).data?.stats?.items))

  const applied = cli(['ingest', '--file', file, '--source', 'ChatGPT', '--apply'])
  check('A3 apply 后写入 2 条', /已写入 2 条/.test(applied.stdout), applied.stdout.slice(-80))
  const items = json(['panel']).data?.items ?? []
  check('A4 画像里出现这 2 条', items.length === 2, String(items.length))
  check('A5 第二人称被改写成「用户…」', items.every((item) => item.text.startsWith('用户')), items.map((i) => i.text).join(' / '))
}

// ---- B 段：归类优先级 ----
{
  const file = sample('b', [
    '- 你要求回复尽量简短一点',
    '- 你正在准备一个竞赛，计划明年上线自己的产品',
    '- 你不希望别人修改你的项目文件夹',
  ].join('\n'))
  const out = cli(['ingest', '--file', file, '--source', 'Kimi']).stdout
  check('B1 「回复简短」落到沟通与表达（不被红线抢走）', /## 沟通与表达[\s\S]*?回复尽量简短/.test(out), out.slice(0, 200))
  check('B2 「计划明年上线」落到目标与计划（不被职业抢走）', /## 目标与计划[\s\S]*?计划明年上线/.test(out), out.slice(0, 200))
  check('B3 「不希望别人改我的文件夹」落到约束与红线', /## 约束与红线[\s\S]*?不希望别人修改/.test(out), out.slice(0, 240))
  check('B4 硬性要求给了核心标记', /（核心）/.test(out), out.slice(0, 240))
}

// ---- C 段：一句话两件事要拆开 ----
{
  const file = sample('c', '- 你习惯在晚上工作，通常先给结论再补细节')
  const out = cli(['ingest', '--file', file, '--source', '豆包']).stdout
  check('C1 习惯与沟通被拆成两个大类', /## 习惯与节奏/.test(out) && /## 沟通与表达/.test(out), out.slice(0, 260))
  check('C2 拆出来的半句补上了主语', /- \[\d\.\d\d\] 用户通常先给结论/.test(out), out.slice(0, 260))
}

// ---- D 段：隐私与噪声 ----
{
  const file = sample('d', [
    '- 我的证件号是 110101199003071234',
    '- 我平时用 13812345678 联系',
    '- 以上信息仅供参考，可能并不完全准确',
    '- 哈哈',
  ].join('\n'))
  const out = cli(['ingest', '--file', file, '--source', 'ChatGPT']).stdout
  check('D1 证件号被拦下（不收录）', /疑似隐私/.test(out) || /未收录|跳过/.test(out), out.slice(0, 200))
  check('D2 手机号被打码而不是原样写入', /⟨手机号⟩/.test(out), out.slice(0, 200))
  check('D3 免责声明与寒暄被丢掉', !/仅供参考/.test(out) && !/哈哈/.test(out), out.slice(0, 200))
  const decl = readFileSync(join(HOME, 'declarations.jsonl'), 'utf8')
  check('D4 落盘里没有明文手机号', !/13812345678/.test(decl), 'declarations.jsonl')
}

// ---- E 段：重复导入不重复长 ----
{
  const file = sample('e', ['- 你是一名本科生', '- 你希望回答简短，不要废话'].join('\n'))
  const out = cli(['ingest', '--file', file, '--source', 'ChatGPT', '--apply']).stdout
  const items = json(['panel']).data?.stats?.items ?? 0
  check('E1 第二次导入被判为「画像里已有」', /画像里已有/.test(out) || /已写入 0 条/.test(out), out.slice(0, 160))
  check('E2 条目数没有翻倍', items <= 2, String(items))
}

// ---- F 段：输入形状与溯源 ----
{
  const file = sample('f', JSON.stringify({ facts: ['你使用 Python 做数据分析', '你喜欢极简的界面'] }))
  const out = cli(['ingest', '--file', file, '--source', 'Cursor']).stdout
  check('F1 JSON 输入被展开成条目', /## 能力与工具/.test(out) && /## 审美与口味/.test(out), out.slice(0, 240))

  cli(['ingest', '--file', file, '--source', 'Cursor', '--apply'])
  const rows = readFileSync(join(HOME, 'declarations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const imported = rows.filter((row) => row?.provenance?.kind === 'import')
  check('F2 溯源记下来源工具名', imported.some((row) => row.provenance.source === 'Cursor'), JSON.stringify(imported.map((row) => row.provenance?.source ?? '?')))
  check('F3 二手来源权重不超过 0.85', imported.every((row) => SomeWeightOk(row.confidence)), imported.map((row) => row.confidence).join(','))
}

function SomeWeightOk(weight) {
  return typeof weight === 'number' && weight >= 0.35 && weight <= 0.85
}

// ---- G 段：缺输入要给人话，而不是崩 ----
{
  const r = cli(['ingest'])
  check('G1 没给输入时说明怎么用', r.code !== 0 && /--file|--text/.test(r.stderr + r.stdout), (r.stderr + r.stdout).slice(0, 120))
  const empty = sample('g', '以下是我了解到的信息：\n\n（暂无）')
  const r2 = cli(['ingest', '--file', empty])
  check('G2 全是噪声时直接说「没识别到可用的陈述」', r2.code !== 0 && /没识别到/.test(r2.stderr + r2.stdout), (r2.stderr + r2.stdout).slice(0, 140))
  const r3 = cli(['ingest', '--file', join(HOME, 'nope.txt')])
  check('G3 文件不存在时提示读不到', r3.code !== 0 && /读不到/.test(r3.stderr + r3.stdout), (r3.stderr + r3.stdout).slice(0, 120))
}

// ---- H 段：MCP 同一个入口 ----
{
  const payload = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"t","version":"1"}}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"profile_ingest","arguments":{"text":"- 你喜欢科幻电影","source":"ChatGPT"}}}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"profile_ingest","arguments":{}}}',
  ].join('\n')
  const proc = spawnSync(process.execPath, [MCP], { input: payload, encoding: 'utf8', env: process.env, timeout: 40000 })
  const lines = (proc.stdout ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const ok = lines.find((r) => r.id === 2)
  const bad = lines.find((r) => r.id === 3)
  check('H1 MCP profile_ingest 返回分类预览', /兴趣与爱好/.test(ok?.result?.content?.[0]?.text ?? ''), String(ok?.result?.content?.[0]?.text ?? '').slice(0, 80))
  check('H2 MCP 缺 text 时明确报错', bad?.result?.isError === true || /text/.test(JSON.stringify(bad ?? {})), JSON.stringify(bad ?? {}).slice(0, 120))
}

if (failures.length === 0) {
  process.stdout.write(`\n第七轮排查（从别的 AI 搬回画像）：${pass} 项全部通过\n`)
  process.exit(0)
}
process.stdout.write(`\n第七轮排查：${failures.length} 项失败\n`)
for (const item of failures) process.stdout.write(`  - ${item}\n`)
process.exit(1)


