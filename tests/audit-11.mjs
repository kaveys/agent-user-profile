/**
 * 第十一轮排查 —— 专查「状态字段在合并/覆盖里被静默吞掉」这一类。
 *
 * 这类 bug 的共同点：命令全部成功、退出码全 0、面板不报错，
 * 只有对比「用户刚才做了什么」和「画像里现在有什么」才能发现。
 * 每个用例都先制造一次「状态 + 后续动作」，再断言状态还在。
 *
 * 覆盖：
 *   P1 置顶在同 key 新记录到达后仍在（build 取整组并集）
 *   P2 声明不会被并进「先放下」的记录里
 *   P3 merge 保留被并侧的置顶
 *   P4 merge 不会让活跃条目跟着「先放下」一起消失
 *   P5 dedupe 保留组内任一成员的置顶，且不碰「先放下」的记录
 *   P6 预算不够时不裁红线、不留空标题
 *   P7 批量 --ids 只留一份快照（不是每条一份）
 *   P8 显式 --key 相同时才算「同名覆盖」，不同 key 不按相似度合并
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-a11-'))
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

/** 画像里所有条目（扁平化），只取活着的。 */
const items = () => {
  const profile = readJson('profile.json')
  const out = []
  for (const [dim, bucket] of Object.entries(profile.dimensions ?? {})) {
    for (const item of bucket.items ?? []) out.push({ dim, ...item })
  }
  return out
}
const snapshots = (kind) =>
  existsSync(join(HOME, 'snapshots'))
    ? readdirSync(join(HOME, 'snapshots')).filter((f) => f.includes(`declarations-${kind}`)).length
    : 0

cli(['init'])

// ---------------------------------------------------------------- P1 置顶跨记录存活
cli(['declare', '--dim', 'habits', '--key', 'habits.same', '--fact', '用户习惯先给结论再给证据', '--confidence', '0.8'])
cli(['pin', '--key', 'habits.same'])
cli(['declare', '--dim', 'habits', '--key', 'habits.same', '--fact', '用户总是先给结论，再补证据', '--confidence', '0.9'])
{
  const same = items().filter((i) => i.key === 'habits.same')
  const pinned = same.filter((i) => i.pinned === true)
  check('P1 同 key 新记录到达后置顶仍在', pinned.length === 1, `items=${same.length} pinned=${pinned.length}`)
  check('P1 注入里仍出现「钉住」段', read('inject.md').includes('## 零、钉住'))
}

// ---------------------------------------------------------------- P2 不并进「先放下」的记录
cli(['declare', '--dim', 'taste', '--key', 'taste.a', '--fact', '喜欢极简的界面风格', '--confidence', '0.7'])
cli(['retire', '--key', 'taste.a'])
cli(['declare', '--dim', 'taste', '--fact', '喜欢极简的界面风格和留白', '--confidence', '0.8'])
{
  const live = items().filter((i) => i.dim === 'taste')
  const retiredRows = declarations().filter((d) => d.retiredAt !== undefined)
  check('P2 新声明没有被并进「先放下」的记录', live.length === 1, `taste 活条目=${live.length}`)
  check('P2 被放下的记录仍留在 declarations 里', retiredRows.length === 1, `retired=${retiredRows.length}`)
  check('P2 新声明正文在画像里', live.some((i) => String(i.text).includes('留白')), live.map((i) => i.text).join(' | '))
}

// ---------------------------------------------------------------- P3/P4 merge 的状态并集
cli(['declare', '--dim', 'interests', '--key', 'interests.keep', '--fact', '喜欢看科幻电影', '--confidence', '0.6'])
cli(['declare', '--dim', 'interests', '--key', 'interests.drop', '--fact', '喜欢看科幻类的电影', '--confidence', '0.6'])
{
  const rows = declarations().filter((d) => d.dim === 'interests')
  const keep = rows.find((r) => r.key === 'interests.keep')
  const drop = rows.find((r) => r.key === 'interests.drop')
  cli(['pin', '--id', drop.id])
  cli(['merge', '--keep', keep.id, '--drop', drop.id])
  const merged = items().filter((i) => i.key === 'interests.keep')
  check('P3 merge 保留被并侧的置顶', merged.length === 1 && merged[0].pinned === true, `pinned=${merged[0]?.pinned}`)
}

cli(['declare', '--dim', 'goals', '--key', 'goals.keep', '--fact', '想在本学期把插件做完', '--confidence', '0.6'])
cli(['declare', '--dim', 'goals', '--key', 'goals.drop', '--fact', '想在本学期内把插件做完', '--confidence', '0.7'])
{
  const rows = declarations().filter((d) => d.dim === 'goals')
  const keep = rows.find((r) => r.key === 'goals.keep')
  const drop = rows.find((r) => r.key === 'goals.drop')
  cli(['retire', '--id', keep.id])
  cli(['merge', '--keep', keep.id, '--drop', drop.id])
  const live = items().filter((i) => i.dim === 'goals')
  check('P4 活跃条目没有跟着「先放下」一起消失', live.length === 1, `goals 活条目=${live.length}`)
}

// ---------------------------------------------------------------- P5 dedupe 的置顶与 retired
cli(['declare', '--dim', 'skills', '--key', 'skills.a', '--fact', '会用 Node 写小工具', '--confidence', '0.6'])
cli(['declare', '--dim', 'skills', '--key', 'skills.b', '--fact', '会用 Node.js 写小工具', '--confidence', '0.7'])
{
  const rows = declarations().filter((d) => d.dim === 'skills')
  const first = rows.find((r) => r.key === 'skills.a')
  cli(['pin', '--id', first.id])
  cli(['dedupe', '--apply'])
  const live = items().filter((i) => i.dim === 'skills')
  check('P5 dedupe 保留组内成员的置顶', live.length === 1 && live[0].pinned === true, `pinned=${live[0]?.pinned}`)
}

cli(['declare', '--dim', 'social', '--key', 'social.a', '--fact', '喜欢和同学一起做项目', '--confidence', '0.6'])
cli(['retire', '--key', 'social.a'])
{
  const before = declarations().filter((d) => d.dim === 'social' && d.retiredAt !== undefined).length
  cli(['dedupe', '--apply'])
  const after = declarations().filter((d) => d.dim === 'social' && d.retiredAt !== undefined).length
  check('P5 dedupe 不碰「先放下」的记录', before === 1 && after === 1, `retired ${before} → ${after}`)
}

// ---------------------------------------------------------------- P6 预算不够时不裁红线
cli(['declare', '--dim', 'constraints', '--fact', '用户要求对外内容必须彻底脱敏', '--confidence', '0.9', '--core'])
cli(['set', 'inject.maxChars', '40'])
{
  cli(['build', '--all-scopes'])
  const inject = read('inject.md')
  const body = inject.split('\n').filter((line) => line.startsWith('## ') || line.startsWith('- ['))
  const orphanHeader = body.some((line, index) => line.startsWith('## ') && !String(body[index + 1] ?? '').startsWith('- ['))
  check('P6 红线段不被预算裁掉', /## 一、红线与硬要求/.test(inject) && inject.includes('彻底脱敏'))
  check('P6 没有只有标题的空段', orphanHeader === false, orphanHeader ? '存在空标题' : '')
}
cli(['set', 'inject.maxChars', '0'])

// ---------------------------------------------------------------- P7 批量只留一份快照
{
  const ids = []
  for (let i = 0; i < 25; i += 1) {
    const out = cli(['declare', '--dim', 'taste', '--key', `taste.bulk${i}`, '--fact', `第 ${i} 条批量测试偏好`, '--confidence', '0.5', '--no-merge'])
    const found = declarations().find((d) => d.key === `taste.bulk${i}`)
    if (found !== undefined) ids.push(found.id)
  }
  const before = snapshots('retire')
  cli(['retire', '--ids', ids.join(',')])
  const after = snapshots('retire')
  check('P7 批量放下只产生 1 份快照', after - before === 1, `快照 ${before} → ${after}（${ids.length} 条）`)
}

// ---------------------------------------------------------------- P8 显式 key 不按相似度合并
cli(['declare', '--dim', 'taste', '--key', 'taste.live', '--fact', '喜欢深色界面', '--confidence', '0.6'])
cli(['declare', '--dim', 'taste', '--key', 'taste.old', '--fact', '喜欢深色界面主题', '--confidence', '0.6'])
{
  const rows = declarations().filter((d) => d.key === 'taste.live' || d.key === 'taste.old')
  check('P8 不同显式 key 不合并', rows.length === 2, `rows=${rows.length}`)
}

// ---------------------------------------------------------------- 汇总
if (failures.length > 0) {
  console.log(`\n第十一轮排查：${failures.length} 项失败 / ${passed + failures.length} 项`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`\n第十一轮排查：全部通过（${passed} 项）`)
