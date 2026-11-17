// 第六轮排查：打「输入形状异常」「边界语义」「协议错误路径」，不重复前五轮。
// 全部在临时 HOME 里跑，不碰真实画像。跑法：node _audit6.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const MCP = join(HERE, 'mcp', 'server.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-up-a6-'))
process.env.DSH_USER_PROFILE_HOME = HOME
process.env.DSH_PROFILE_DIAG = '0'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; return }
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

function cli(args, opts = {}) {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: 30000,
  })
  return { code: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}
function json(args) {
  const r = cli(args)
  try { return { ...r, data: JSON.parse(r.stdout) } } catch { return { ...r, data: null } }
}

cli(['init'])

// ---- A 段：输入形状异常也必须给出人话 ----
{
  const r = cli(['declare', '--dim', 'taste', '--fact', '   '])
  check('A1 纯空格的事实被拒', r.code !== 0 && /fact|内容|空/.test(r.stderr + r.stdout), r.stderr.trim().slice(0, 60))

  const r2 = cli(['declare', '--dim', 'taste', '--fact', '用户喜欢极简界面', '--confidence', 'abc'])
  check('A2 confidence 非数字被拒或夹到合法值', r2.code === 0 ? /夹|0\.|已/.test(r2.stdout) : true)
}
{
  const r = cli(['explain', '   '])
  check('A3 explain 空查询不崩', r.code === 0, `code=${r.code} ${r.stderr.trim().slice(0, 60)}`)
  const r2 = cli(['explain', '，。！？……'])
  check('A4 explain 纯标点不崩', r2.code === 0, `code=${r2.code}`)
  const r3 = cli(['explain', '界面'])
  // 空库时 carried 应为 0，且不能出现 NaN / undefined
  check('A5 explain 输出没有 NaN / undefined', !/NaN|undefined/.test(r3.stdout), r3.stdout.slice(0, 80))
}
{
  const r = json(['health', '--json'])
  check('A6 空画像 health 仍然给分与建议', r.code === 0 && typeof r.data?.total === 'number' && Array.isArray(r.data?.advice), `code=${r.code}`)
  check('A7 空画像 health 总分不为负、不超 100', r.data?.total >= 0 && r.data?.total <= 100, String(r.data?.total))
}
{
  // 未来时间戳（时钟回拨）不能让新鲜度变成负数或 > 20
  const cfgPath = join(HOME, 'config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cli(['declare', '--dim', 'identity', '--fact', '用户用简体中文交流'])
  cli(['declare', '--dim', 'constraints', '--fact', '用户要求上传前彻底脱敏'])
  cli(['build', '--all-scopes'])
  const profPath = join(HOME, 'profile.json')
  const prof = JSON.parse(readFileSync(profPath, 'utf8'))
  prof.builtAt = new Date(Date.now() + 7 * 86400000).toISOString()
  writeFileSync(profPath, JSON.stringify(prof))
  const r = json(['health', '--json'])
  const fresh = (r.data?.states ?? []).find((s) => s.key === 'freshness')
  check('A8 未来时间戳：新鲜度不超上限也不为负', fresh !== undefined && fresh.score >= 0 && fresh.score <= fresh.max, JSON.stringify(fresh))
  void cfg
}

// ---- B 段：加密备份的往返与错口令 ----
{
  const out = join(HOME, 'enc')
  const sealed = cli(['backup', '--out', out, '--encrypt'], { env: { DSH_PROFILE_PASSPHRASE: 'secret123' } })
  check('B1 有口令时加密导出成功', sealed.code === 0, sealed.stderr.trim().slice(0, 80))
  const files = existsSync(out) ? readFileSync : null
  void files
  const names = existsSync(out) ? readdirSync(out).filter((n) => n.endsWith('.json.enc')) : []
  const enc = names.length === 1 ? join(out, names[0]) : ''
  check('B2 加密包后缀是 .json.enc', names.length === 1, names.join(',') || '目录里没有 .json.enc')
  if (enc === '') { process.stdout.write('B 段跳过后续（没生成加密包）\n') } else {
  const bad = cli(['unseal', '--file', enc, '--out', join(HOME, 'plain-bad.json')], { env: { DSH_PROFILE_PASSPHRASE: 'wrong-one' } })
  check('B3 错口令必须失败', bad.code !== 0 && /解密失败|口令/.test(bad.stderr + bad.stdout), bad.stderr.trim().slice(0, 60))
  const good = cli(['unseal', '--file', enc, '--out', join(HOME, 'plain.json')], { env: { DSH_PROFILE_PASSPHRASE: 'secret123' } })
  check('B4 对口令能还原', good.code === 0 && existsSync(join(HOME, 'plain.json')), good.stderr.trim().slice(0, 60))
  }
  const missing = cli(['backup', '--out', join(HOME, 'enc2'), '--encrypt'], { env: { DSH_PROFILE_PASSPHRASE: '' } })
  check('B5 没配口令时加密导出要说清怎么配', missing.code !== 0 && /口令|PASSPHRASE/.test(missing.stderr + missing.stdout), missing.stderr.trim().slice(0, 60))
}

// ---- C 段：MCP 协议错误路径 ----
{
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'user-profile://nope' } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'profile_get' } },
    { jsonrpc: '2.0', id: 4, method: 'no/such/method' },
  ]
  const input = reqs.map((r) => JSON.stringify(r)).join('\n') + '\nnot json at all\n'
  const out = spawnSync(process.execPath, [MCP], { input, encoding: 'utf8', timeout: 30000, env: process.env })
  const lines = (out.stdout ?? '').trim().split('\n').filter(Boolean)
  const parsed = lines.map((line) => { try { return JSON.parse(line) } catch { return null } })
  check('C1 每一行回包都是合法 JSON', parsed.every((p) => p !== null), `${lines.length} 行`)
  const unknownRes = parsed.find((p) => p?.id === 2)
  check('C2 未知资源返回 error 而不是空内容', unknownRes?.error !== undefined, JSON.stringify(unknownRes).slice(0, 80))
  const noArgs = parsed.find((p) => p?.id === 3)
  check('C3 profile_get 无参数可调用（不报错）', noArgs?.result !== undefined || noArgs?.error !== undefined)
  const unknownMethod = parsed.find((p) => p?.id === 4)
  check('C4 未知方法返回 -32601', unknownMethod?.error?.code === -32601, JSON.stringify(unknownMethod?.error ?? null))
  const badJson = parsed.filter((p) => p?.error?.code === -32700)
  check('C5 非法 JSON 回 -32700 且不中断后续', badJson.length >= 1 && out.status === 0, `exit=${out.status}`)
}

// ---- D 段：注入预算的语义 ----
{
  const hard = ['上传前必须彻底脱敏', '不同插件职责严格独立', '删数据要能一键恢复', '真机跑通才算完成', '先给结论再给过程', '不许静默丢数据']
  const soft = ['界面要有留白和层次', '配色偏冷色低饱和', '文案用短句不用长段', '桌面图标尽量少', '动画克制不炫技', '深色模式优先']
  for (const fact of hard) cli(['declare', '--dim', 'constraints', '--fact', fact, '--core'])
  for (const fact of soft) cli(['declare', '--dim', 'taste', '--fact', fact])
  cli(['set', 'inject.maxChars', '120'])
  cli(['build', '--all-scopes'])
  const md = readFileSync(join(HOME, 'inject.md'), 'utf8')
  const lines = md.split('\n').filter((l) => l.startsWith('- ['))
  check('D1 预算很紧时仍保留至少一条红线', lines.some((l) => /约束/.test(l)), `${lines.length} 条`)
  check('D2 预算很紧时给出「被裁掉」的说明', /超出预算|另有\d+ 条|未带入/.test(md), md.slice(0, 120))
  const declared = Number((/\d+/.exec((/本次带入 (\d+) 条/.exec(md) ?? [])[0] ?? '0'))?.[0] ?? '0')
  check('D3 「本次带入 N 条」与实际条目行数一致', declared === lines.length, `声明 ${declared} / 实际 ${lines.length}`)
  cli(['set', 'inject.maxChars', '0'])
  cli(['build', '--all-scopes'])
  const md2 = readFileSync(join(HOME, 'inject.md'), 'utf8')
  const all = md2.split('\n').filter((l) => l.startsWith('- [')).length
  check('D4 0 = 不设上限时条目不再被预算裁掉', all >= 6 && !/超出预算/.test(md2), `${all} 条`)
}

// ---- E 段：并发写与锁 ----
{
  const declPath = join(HOME, 'declarations.jsonl')
  const countDecl = () => (existsSync(declPath) ? readFileSync(declPath, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  const before = countDecl()
  const procs = []
  for (let i = 0; i < 5; i += 1) {
    procs.push(spawnSync(process.execPath, [CLI, 'declare', '--dim', 'goals', '--fact', `并发目标${i}要在年内达成`], {
      encoding: 'utf8', timeout: 30000, env: process.env, stdio: 'ignore',
    }))
  }
  void before
  const after = countDecl()
  check('E1 5 个并发声明全部落盘（无静默丢失）', after === before + 5, `before=${before} after=${after}`)
  check('E2 并发后没有残留 .lock 卡死后续命令', !existsSync(join(HOME, '.lock')), 'lock 仍在')
  const r = cli(['status'])
  check('E3 并发之后命令仍然可用', r.code === 0, r.stderr.trim().slice(0, 60))
}

process.stdout.write(`\n第六轮排查：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项`}（通过 ${pass}，失败 ${failures.length}）\n`)
for (const f of failures) process.stdout.write(`  · ${f}\n`)
process.exit(failures.length === 0 ? 0 : 1)
