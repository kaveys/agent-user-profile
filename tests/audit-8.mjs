// 第八轮排查：专测「相似条目主动合并」（v25）。
// 判据不是「代码跑通了」，而是「同义改写真的并成一条、不相关的真的没被并」。
// 全部在临时 HOME 里跑，不碰真实画像。跑法：node _audit8.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const MCP = join(HERE, 'mcp', 'server.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-up-a8-'))
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
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env, timeout: 30000 })
  return { code: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}
function json(args) {
  const r = cli(args)
  try { return { ...r, data: JSON.parse(r.stdout) } } catch { return { ...r, data: null } }
}
const decls = () => readFileSync(join(HOME, 'declarations.jsonl'), 'utf8')
  .split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
const panelItems = () => json(['panel']).data?.items ?? []

cli(['init'])

// ---- A 段：写入端自动合并（declare） ----
{
  const r1 = cli(['declare', '--dim', 'taste', '--fact', '用户要求界面简洁，不要花哨动画', '--force'])
  check('A1 第一条正常记录', r1.code === 0 && /已记录/.test(r1.stdout), r1.stdout.slice(-60))

  const r2 = cli(['declare', '--dim', 'taste', '--fact', '界面要简洁，别整那些花哨的动画效果', '--force'])
  check('A2 同义改写被合并（不是再记一条）', /已合并到已有条目/.test(r2.stdout), r2.stdout.slice(-100))
  check('A3 合并回执给出判定分', /同义判定 0\.\d\d/.test(r2.stdout), r2.stdout.slice(-60))
  check('A4 落库只剩 1 条', decls().length === 1, String(decls().length))
  check('A5 原句进了 mergedFrom', (decls()[0].mergedFrom ?? []).length === 1, JSON.stringify(decls()[0].mergedFrom))

  const r3 = cli(['declare', '--dim', 'habits', '--fact', '用户习惯先给结论，再给证据', '--force'])
  check('A6 不相关的内容不会被误并', /已记录/.test(r3.stdout) && decls().length === 2, r3.stdout.slice(-60))

  const r4 = cli(['declare', '--dim', 'taste', '--fact', '界面简单点就好，不要动画', '--no-merge', '--force'])
  check('A7 --no-merge 可强制单独存', /已记录/.test(r4.stdout) && decls().length === 3, r4.stdout.slice(-60))
}

// ---- B 段：dedupe 预览 / 落库（用手工 --no-merge 造出「已经存进去的相似条目」） ----
{
  cli(['reset', '--yes'])
  cli(['declare', '--dim', 'constraints', '--fact', '上传前必须彻底脱敏，抹掉用户名和本地路径', '--no-merge', '--force'])
  cli(['declare', '--dim', 'constraints', '--fact', '对外公开内容前必须彻底脱敏（用户名、本地路径都要抹掉）', '--no-merge', '--force'])
  cli(['declare', '--dim', 'habits', '--fact', '用户习惯先给结论，再给证据', '--no-merge', '--force'])
  const before = decls().length
  check('B0 造出 3 条（其中 2 条同义）', before === 3, String(before))

  const preview = cli(['dedupe'])
  check('B1 预览列出分组并提示 --apply', preview.code === 0 && /发现 1 组/.test(preview.stdout) && /--apply/.test(preview.stdout), preview.stdout.slice(0, 120))
  check('B2 预览不改数据', decls().length === before, String(decls().length))

  const applied = cli(['dedupe', '--apply'])
  check('B3 apply 真的合并了', /已合并 1 组/.test(applied.stdout), applied.stdout.slice(-120))
  check('B4 条数下降', decls().length === before - 1, `${before} → ${decls().length}`)
  check('B5 合并后仍有 mergedFrom 记录', decls().some((row) => (row.mergedFrom ?? []).length > 0), JSON.stringify(decls().map((r) => (r.mergedFrom ?? []).length)))
  check('B6 合并后留有快照', json(['snapshots']).stdout.includes('dedupe'), json(['snapshots']).stdout.slice(0, 120))
  const noop = cli(['dedupe'])
  check('B7 再跑一次是 no-op', /没有发现可合并的相似条目/.test(noop.stdout), noop.stdout.slice(0, 80))
  check('B8 不相关的那条还在', decls().some((row) => row.dim === 'habits'), decls().map((r) => r.dim).join(','))
}

// ---- C 段：阈值与跨大类规则 ----
{
  cli(['reset', '--yes'])
  cli(['declare', '--dim', 'constraints', '--fact', '上传前必须彻底脱敏，抹掉用户名和本地路径', '--force'])
  cli(['declare', '--dim', 'constraints', '--fact', '对外公开内容前必须彻底脱敏（用户名、本地路径都要抹掉）', '--no-merge', '--force'])
  const strict = cli(['dedupe', '--threshold', '0.95'])
  check('C1 阈值调高后不会合并（0.67 < 0.95）', /没有发现可合并/.test(strict.stdout), strict.stdout.slice(0, 80))
  const loose = cli(['dedupe', '--threshold', '0.6'])
  check('C2 阈值放宽后会合并', /发现 1 组/.test(loose.stdout), loose.stdout.slice(0, 80))

  cli(['reset', '--yes'])
  // 跨大类：几乎一字不差才合并（阈值 = max(0.8, 0.35+0.3)）
  cli(['declare', '--dim', 'habits', '--fact', '用户每天上午先看邮件再写代码', '--force'])
  cli(['declare', '--dim', 'interests', '--fact', '用户每天上午先看邮件再写代码', '--no-merge', '--force'])
  const cross = cli(['dedupe', '--apply'])
  check('C3 跨大类完全相同会合并', /已合并 1 组/.test(cross.stdout), cross.stdout.slice(-80))
  check('C4 跨大类合并后只剩 1 条', decls().length === 1, String(decls().length))

  cli(['reset', '--yes'])
  cli(['declare', '--dim', 'habits', '--fact', '用户习惯先给结论再展开细节', '--force'])
  cli(['declare', '--dim', 'communication', '--fact', '用户习惯先给结论再展开细节', '--no-merge', '--force'])
  const cross2 = cli(['dedupe', '--apply'])
  check('C5 跨大类完全相同也应合并（不受大类影响）', /已合并 1 组/.test(cross2.stdout), cross2.stdout.slice(-80))
}

// ---- D 段：build 阶段的合并（只影响产物，不改源文件）----
{
  cli(['reset', '--yes'])
  cli(['declare', '--dim', 'taste', '--fact', '用户要求界面像成熟产品，有层次有留白', '--no-merge', '--force'])
  cli(['declare', '--dim', 'taste', '--fact', '界面要像成熟产品那样，有层次、有留白', '--no-merge', '--force'])
  check('D1 源文件仍是 2 条', decls().length === 2, String(decls().length))
  cli(['build', '--all-scopes'])
  const items = panelItems()
  check('D2 build 产物里合并成 1 条', items.length === 1, `${items.length}: ${items.map((i) => i.text).join(' / ')}`)
  check('D3 合并痕迹写进 conflicts', (json(['panel']).data?.conflicts ?? []).some((c) => c.status === 'merged'), JSON.stringify((json(['panel']).data?.conflicts ?? []).map((c) => c.status)))
  check('D4 源文件没被 build 改动（build 只出产物）', decls().length === 2, String(decls().length))
}

// ---- E 段：MCP 入口 ----
{
  const tools = JSON.parse(spawnSync(process.execPath, [MCP], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    encoding: 'utf8',
    env: process.env,
    timeout: 20000,
  }).stdout.trim().split('\n').pop()).result?.tools ?? []
  check('E1 MCP 暴露 profile_dedupe', tools.some((t) => t.name === 'profile_dedupe'), tools.map((t) => t.name).join(','))
  const call = spawnSync(process.execPath, [MCP], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'profile_dedupe', arguments: {} } })}\n`,
    encoding: 'utf8',
    env: process.env,
    timeout: 20000,
  })
  const last = JSON.parse(call.stdout.trim().split('\n').pop())
  check('E2 MCP 调 dedupe 有可读结果', typeof last?.result?.content?.[0]?.text === 'string' && last.result.content[0].text.length > 0, JSON.stringify(last).slice(0, 120))
}

process.stdout.write(`\n${pass} 项通过${failures.length === 0 ? '' : `，${failures.length} 项失败`}\n`)
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
  process.exit(1)
}
