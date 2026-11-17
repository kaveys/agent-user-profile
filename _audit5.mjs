/**
 * 第五轮排查（v20）：专打「两边说的不是一回事」这一类漂移。
 * 前四轮打边界/往返/逻辑，这一轮打：面板与 CLI 的键是否对得上、计数是否自洽、
 * 新加的 explain/health 语义是否正确、MCP 的错误分支是否真的报错。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'audit5-'))
const env = { ...process.env, DSH_USER_PROFILE_HOME: HOME, DSH_PROFILE_DIAG: '0' }

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function run(args, input) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', input })
  return { code: result.status ?? 1, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

function json(args) {
  const r = run(args)
  try {
    return { code: r.code, data: JSON.parse(r.out), out: r.out }
  } catch {
    return { code: r.code, data: undefined, out: r.out }
  }
}

// ---------------------------------------------------------------- 准备数据
run(['init'])
const seeds = [
  ['identity', 'identity.role', '用户是本科在读学生，学的是计算机相关专业', '0.9', '--core'],
  ['taste', 'taste.ui', '用户喜欢克制的深色界面，留白充足，不要花哨渐变', '0.9', '--core'],
  ['communication', 'communication.style', '用户说话很短，希望直接给结论和证据', '0.8'],
  ['habits', 'habits.verify', '用户要求真机跑通并截图才算完成', '0.9'],
  ['constraints', 'constraints.privacy', '用户要求对外发布前彻底脱敏', '0.9'],
  ['skills', 'skills.stack', '用户能读 JS 与 Python，会写 C', '0.6'],
  ['social', 'social.publish', '用户会把自己的工具发到 GitHub', '0.45'],
]
for (const [dim, key, fact, conf, ...rest] of seeds) {
  run(['declare', '--dim', dim, '--key', key, '--fact', fact, '--confidence', conf, ...rest])
}

const panel = json(['panel']).data
check('panel 能解析', panel !== undefined)

// ---------------------------------------------------------------- A. 键的漂移
function leafPaths(object, prefix = '') {
  const out = []
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(...leafPaths(value, path))
    else out.push(path)
  }
  return out
}

const setList = run(['set', 'list']).out
const settingsKeys = leafPaths(panel?.settings ?? {}).filter((path) => path !== 'enabled')
const unsettable = settingsKeys.filter((path) => !setList.includes(path))
check(
  'A1 面板上的每个可编辑字段都能用 set 改（无漂移）',
  unsettable.length === 0,
  unsettable.join(', '),
)

const specOnly = ['inject.maxChars', 'inject.topK', 'inject.relevantOnly', 'inject.mode', 'conflicts.strategy']
const missingInPayload = specOnly.filter((path) => !settingsKeys.includes(path))
check('A2 set 支持的关键字段都出现在面板 payload 里', missingInPayload.length === 0, missingInPayload.join(', '))

// ---------------------------------------------------------------- B. 计数自洽
const items = panel?.items ?? []
const partitions = panel?.partitions ?? []
const partitionSum = partitions.reduce((sum, row) => sum + row.n, 0)
check('B1 分区条数之和 = 条目总数', partitionSum === items.length, `${partitionSum} vs ${items.length}`)
check('B2 stats.items = 条目数组长度', panel?.stats?.items === items.length, `${panel?.stats?.items} vs ${items.length}`)
check('B3 每个条目都带 partition 与 provenance 字段', items.every((item) => typeof item.partition === 'string' && 'provenance' in item))
check('B4 三类分区都在 payload 里', partitions.length === 3 && partitions.every((row) => typeof row.label === 'string' && row.label.length > 0))
check('B5 stats.history 是数字、historyItems 是数组', typeof panel?.stats?.history === 'number' && Array.isArray(panel?.historyItems))

// ---------------------------------------------------------------- C. health 语义
const health = panel?.health
check('C1 health 五项齐全', Array.isArray(health?.states) && health.states.length === 5)
const sumScores = (health?.states ?? []).reduce((sum, state) => sum + state.score, 0)
check('C2 health.total = 五项之和', health?.total === sumScores, `${health?.total} vs ${sumScores}`)
check('C3 每项都不超上限', (health?.states ?? []).every((state) => state.score >= 0 && state.score <= state.max))
check('C4 health 给了建议', Array.isArray(health?.advice) && health.advice.length > 0)

const healthJson = json(['health', '--json']).data
check('C5 health --json 可解析且与 panel 一致', healthJson?.total === health?.total)

// 造一个「陈旧画像」：把 builtAt 改到 30 天前，新鲜度必须掉下来
const profilePath = join(HOME, 'profile.json')
const profileRaw = JSON.parse(readFileSync(profilePath, 'utf8'))
profileRaw.builtAt = new Date(Date.now() - 30 * 86400000).toISOString()
writeFileSync(profilePath, JSON.stringify(profileRaw, null, 2))
const staleHealth = json(['health', '--json']).data
const freshness = staleHealth?.states?.find((state) => state.key === 'freshness')
check('C6 30 天没重建 → 新鲜度掉到 0', freshness?.score === 0, String(freshness?.score))
run(['build', '--all-scopes'])
const freshAgain = json(['health', '--json']).data
check('C7 重建后新鲜度回到满格', freshAgain?.states?.find((state) => state.key === 'freshness')?.score === 20)

// ---------------------------------------------------------------- D. explain 语义
const explain = json(['explain', '界面 风格', '--json'])
check('D1 explain --json 可解析', explain.data !== undefined)
const carried = explain.data?.carried ?? []
const dropped = explain.data?.dropped ?? []
check('D2 带入 + 挡掉 = 全部条目', carried.length + dropped.length === items.length, `${carried.length}+${dropped.length} vs ${items.length}`)
check('D3 相关的条目真的被带进来（界面/审美）', carried.some((item) => item.dim === 'taste'))
check('D4 无关条目被挡掉（技能栈）', dropped.some((item) => item.dim === 'skills'))
check('D5 红线维度即使无关也带入', carried.some((item) => item.redline === true))
const textExplain = run(['explain', '界面 风格']).out
check('D6 文本版讲清了判定规则', textExplain.includes('挡掉不等于删除'))
check('D7 无关键词时不崩', run(['explain']).code === 0)

// ---------------------------------------------------------------- E. 脏数据与文件
writeFileSync(join(HOME, 'declarations.jsonl'), `${readFileSync(join(HOME, 'declarations.jsonl'), 'utf8')}{"broken": \n`)
const dirty = json(['panel'])
check('E1 declarations 出现坏行时 panel 仍可用', dirty.data !== undefined)
check('E2 坏行被隔离并给出提示', (dirty.data?.warnings ?? []).some((line) => line.includes('损坏')))

// ---------------------------------------------------------------- F. 命令与参数
check('F1 未知命令非零退出', run(['nope']).code !== 0)
check('F2 set 未知键被拒', run(['set', 'inject.nope', '1']).code !== 0)
check('F3 set 越界被拒', run(['set', 'inject.maxChars', '-5']).code !== 0)
check('F4 set 合法值可写并回读', (() => {
  const wrote = run(['set', 'inject.maxChars', '4000'])
  const after = json(['panel']).data
  return wrote.code === 0 && after?.settings?.inject?.maxChars === 4000
})())
check('F5 恢复成不设上限', run(['set', 'inject.maxChars', '0']).code === 0)
check('F6 forget 无匹配时非零退出', run(['forget', '--key', 'does.not.exist']).code !== 0)
check('F7 export 到目录成功', (() => {
  const out = join(HOME, 'export')
  const r = run(['export', '--out', out])
  return r.code === 0 && existsSync(out)
})())

// ---------------------------------------------------------------- 汇总
console.log('')
console.log(`第五轮排查：${fail === 0 ? '全部通过' : `${fail} 项失败`}（通过 ${pass}，失败 ${fail}）`)
if (fail > 0) console.log(failures.map((line) => `  · ${line}`).join('\n'))
process.exit(fail === 0 ? 0 : 1)
