/**
 * 第十二轮排查 —— v35「生命周期」这一层：时效、置信度裁决、时间衰减、按证据撤销。
 *
 * 这一类问题同样是「命令全成功、退出码全 0」，但用户看到的是：
 *   - 临时状态过期了还赖在注入里；
 *   - 随口一句把明确要求过的红线顶掉；
 *   - 三个月前的偏好还在当现在的你；
 *   - 想让某轮对话带来的结论整体消失，只能一条条删。
 *
 * 覆盖：
 *   P1 --ttl / --expires：过期后退出画像，记录仍在，stats.expired 记数
 *   P2 wise 裁决：低置信度新值不覆盖高置信度旧值，进 needs_review
 *   P3 退回 newest：显式切换后仍然「新的覆盖旧的」
 *   P4 时间衰减：久未提及的条目权重下降，降到 floor 以下不再注入
 *   P5 forget --session：按证据撤销，只删那一轮带来的结论
 *   P6 注入块对淡化条目留一句说明，不静默消失
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-a12-'))
const env = { ...process.env, DSH_USER_PROFILE_HOME: HOME, DSH_PROFILE_DIAG: '0' }

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
const texts = () => items().map((item) => item.text)

cli(['init'])

// ── P1 时效：过期的临时状态退出画像，但记录留着 ───────────────────────────
cli(['declare', '--dim', 'goals', '--fact', '这周在准备答辩', '--key', 'goals.week', '--ttl', '7d'])
check('P1a --ttl 写进了 expiresAt', typeof declarations()[0]?.expiresAt === 'string', declarations()[0]?.expiresAt)
cli(['build'])
check('P1b 未到期的临时状态在画像里', texts().some((t) => t.includes('准备答辩')))
// 把到期时间改到昨天，模拟时间流逝
writeDeclarations(declarations().map((r) => ({ ...r, expiresAt: new Date(Date.now() - 86400000).toISOString() })))
cli(['build'])
check('P1c 过期后退出画像', !texts().some((t) => t.includes('准备答辩')))
check('P1d 过期记录仍在 declarations.jsonl（可查、可改期）', declarations().some((r) => String(r.fact ?? '').includes('准备答辩')))
check('P1e stats.expired 记数', readJson('profile.json').stats.expired === 1, String(readJson('profile.json').stats.expired))

// ── P2/P3 置信度裁决 ────────────────────────────────────────────────────────
cli(['declare', '--dim', 'taste', '--fact', '喜欢简洁直接的答复', '--key', 't.style', '--confidence', '1'])
cli(['declare', '--dim', 'taste', '--fact', '喜欢啰嗦一点的说法', '--key', 't.style', '--confidence', '0.6', '--source', 'model'])
cli(['build'])
check('P2a wise：低置信度新值没有顶掉高置信度旧值', texts().some((t) => t.includes('简洁直接')), texts().join(' | '))
const wiseConflicts = readJson('profile.json').conflicts ?? []
check('P2b wise：冲突记为 needs_review', wiseConflicts.some((c) => c.status === 'needs_review'), JSON.stringify(wiseConflicts.map((c) => c.status)))
cli(['set', 'conflicts.strategy', 'newest'])
cli(['build'])
check('P3 退回 newest 后仍是「新的覆盖旧的」', texts().some((t) => t.includes('啰嗦')), texts().join(' | '))
cli(['set', 'conflicts.strategy', 'wise'])

// ── P4 时间衰减 ────────────────────────────────────────────────────────────
cli(['declare', '--dim', 'interests', '--fact', '曾经喜欢折腾键盘', '--key', 'i.kb', '--confidence', '0.5'])
cli(['declare', '--dim', 'interests', '--fact', '最近在弄无人机', '--key', 'i.uav', '--confidence', '1'])
const old = new Date(Date.now() - 200 * 86400000).toISOString()
writeDeclarations(declarations().map((r) => (r.key === 'i.kb' ? { ...r, at: old } : r)))
cli(['build'])
const kb = items().find((item) => item.key === 'i.kb')
check('P4a 久未提及的条目权重下降', kb?.decay?.steps >= 2 && kb.weight < 1, JSON.stringify(kb?.decay) + ` weight=${kb?.weight}`)
check('P4b 最近提过的条目没被衰减', (items().find((item) => item.key === 'i.uav')?.decay ?? null) === null)
const inject = read('inject.md')
check('P4c 衰减到 floor 以下的条目不再进注入', !inject.includes('折腾键盘'))
check('P6 注入块对淡化条目留了说明', inject.includes('已淡化'), inject.split('\n').filter((l) => l.includes('淡化')).join(' / '))

// ── P5 按证据撤销 ──────────────────────────────────────────────────────────
cli(['declare', '--dim', 'work', '--fact', '在做插件 A', '--key', 'w.a', '--session', 'sess-alpha'])
cli(['declare', '--dim', 'work', '--fact', '在做插件 B', '--key', 'w.b', '--session', 'sess-beta'])
cli(['forget', '--session', 'sess-alpha'])
const left = declarations().filter((r) => typeof r.fact === 'string')
check('P5a 只删掉了那个会话带来的结论', !left.some((r) => r.fact.includes('插件 A')), left.map((r) => r.fact).join(' | '))
check('P5b 别的会话的结论不受影响', left.some((r) => r.fact.includes('插件 B')))

console.log(`\n第十二轮排查：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
