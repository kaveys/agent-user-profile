/**
 * 第十三轮排查 —— v35 生命周期落码后的「回看」：状态在合并/衰减/撤销里会不会被悄悄改写。
 *
 * 这一轮的问题全部满足「退出码 0、面板不报错」，但用户看到的是：
 *   - 置顶的条目隔了半年自己变轻了，被一条模型猜的偏好顶掉；
 *   - 想只撤掉某次会话里关于「口味」的结论，结果整个口味维度被清空；
 *   - 给一句话加了保质期，重复说一遍就丢了；
 *   - 从 MCP 那边根本设不了保质期，也撤不了某次会话。
 *
 * 覆盖：
 *   S1/S2 置顶与核心条目永不衰减（权重也不许动）
 *   S3    forget 多个条件取交集，不是并集
 *   S4/S5 同一句再说一遍：带 --ttl 会更新，没带则保留原值
 *   S6    同义合并时带的 --ttl 落到合并后的那条
 *   S7    MCP profile_declare 支持 ttl
 *   S8    MCP profile_forget 支持 session
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const MCP = join(HERE, 'mcp', 'server.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-a13-'))
const env = { ...process.env, DSH_USER_PROFILE_HOME: HOME, DSH_PROFILE_DIAG: '0', DSH_PROFILE_DIR: '' }

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const cli = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: HERE })
const read = (name) => readFileSync(join(HOME, name), 'utf8')
const readJson = (name) => JSON.parse(read(name))
const declarations = () =>
  read('declarations.jsonl')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
const writeDeclarations = (rows) => writeFileSync(join(HOME, 'declarations.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const items = () => Object.values(readJson('profile.json').dimensions).flatMap((section) => section.items)
const backdate = (keys, days) => {
  const old = new Date(Date.now() - days * 86400000).toISOString()
  writeDeclarations(declarations().map((r) => (keys.includes(r.key) ? { ...r, at: old, lastSeen: old } : r)))
}

cli(['init'])

// ── S1/S2 置顶与核心：久不提也不降权 ────────────────────────────────────────
cli(['declare', '--dim', 'habits', '--fact', '习惯先给结论再给证据', '--key', 'h.evidence', '--confidence', '1'])
cli(['declare', '--dim', 'constraints', '--fact', '对外发布前必须脱敏', '--key', 'c.redact', '--confidence', '1', '--core'])
cli(['pin', '--key', 'h.evidence'])
backdate(['h.evidence', 'c.redact'], 400)
cli(['build'])
const pinned = items().find((item) => item.key === 'h.evidence')
const core = items().find((item) => item.key === 'c.redact')
check('S1a 置顶条目不衰减（权重不变）', pinned?.weight === 1 && pinned?.stale !== true, `weight=${pinned?.weight} stale=${pinned?.stale}`)
check('S1b 置顶条目不进 faded 计数', readJson('profile.json').stats.faded === 0, String(readJson('profile.json').stats.faded))
check('S2 核心条目不衰减（权重不变）', core?.weight === 1 && core?.stale !== true, `weight=${core?.weight} stale=${core?.stale}`)

// ── S3 forget 多条件取交集 ─────────────────────────────────────────────────
cli(['declare', '--dim', 'taste', '--fact', '甲会话里的口味', '--key', 't.a', '--session', 'sess-x'])
cli(['declare', '--dim', 'taste', '--fact', '乙会话里的口味', '--key', 't.b', '--session', 'sess-y'])
cli(['declare', '--dim', 'taste', '--fact', '丙会话里的口味', '--key', 't.c', '--session', 'sess-z'])
cli(['forget', '--session', 'sess-x', '--dim', 'taste'])
const afterForget = declarations().map((r) => r.key)
check('S3a 只删掉「这个会话 × 这个维度」那一条', !afterForget.includes('t.a'))
check('S3b 同维度的其他会话不受影响', afterForget.includes('t.b') && afterForget.includes('t.c'), afterForget.join(','))

// ── S4/S5 同一句再说一遍时保质期怎么走 ─────────────────────────────────────
cli(['declare', '--dim', 'goals', '--fact', '本学期把绩点拉到 3.5', '--key', 'g.gpa'])
cli(['declare', '--dim', 'goals', '--fact', '本学期把绩点拉到 3.5', '--key', 'g.gpa', '--ttl', '30d'])
const withTtl = declarations().find((r) => r.key === 'g.gpa')
check('S4 重复声明时带 --ttl 会写进 expiresAt', typeof withTtl?.expiresAt === 'string', withTtl?.expiresAt)
cli(['declare', '--dim', 'goals', '--fact', '本学期把绩点拉到 3.5', '--key', 'g.gpa'])
check('S5 重复声明没带 --ttl 不会抹掉原保质期', typeof declarations().find((r) => r.key === 'g.gpa')?.expiresAt === 'string')

// ── S6 同义合并时带的保质期不能丢 ──────────────────────────────────────────
cli(['declare', '--dim', 'taste', '--fact', '希望回答别绕圈子'])
cli(['declare', '--dim', 'taste', '--fact', '回答不要绕圈子', '--ttl', '7d'])
const merged = declarations().find((r) => String(r.fact ?? '').includes('绕圈子') || (r.mergedFrom ?? []).some((m) => String(m.fact ?? '').includes('绕圈子')))
check('S6 同义合并后仍保留 expiresAt', typeof merged?.expiresAt === 'string', `${merged?.key} expiresAt=${merged?.expiresAt}`)

// ── S7/S8 MCP 能不能用上新能力 ─────────────────────────────────────────────
const mcpCall = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
const runMcp = async (lines) => {
  const child = spawn(process.execPath, [MCP], { env, cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
  child.stdin.write(lines.join('\n') + '\n')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000)
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })
  child.stdin.end()
  child.kill()
  return out
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}
const mcpOut = await runMcp([
  mcpCall('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit-13', version: '1' } }),
  mcpCall('tools/call', { name: 'profile_declare', arguments: { dim: 'goals', fact: '下个月把驾照考下来', ttl: '30d' } }),
  mcpCall('tools/call', { name: 'profile_forget', arguments: { session: 'sess-y' } }),
])
const mcpText = mcpOut.map((m) => JSON.stringify(m.result ?? m.error ?? '')).join(' ')
check('S7 MCP profile_declare 接受 ttl', mcpText.includes('下个月把驾照考下来') && !mcpText.includes('Invalid'), mcpText.slice(0, 160))
const ttlRow = declarations().find((r) => String(r.fact ?? '').includes('驾照'))
check('S7b MCP 写入的条目带 expiresAt', typeof ttlRow?.expiresAt === 'string', ttlRow?.expiresAt)
check('S8 MCP profile_forget 支持 session', !declarations().some((r) => r.session === 'sess-y' && r.key === 't.b'), declarations().map((r) => r.key).join(','))

console.log(`\n第十三轮排查：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
