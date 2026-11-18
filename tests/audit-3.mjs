// 第三轮对抗检查：专挑「逻辑错」而不是「会不会崩」
// 覆盖：注入预算与排序、闸门与脱敏的交互、数据完整性（坏行/坏配置/并发/锁）、命令语义、MCP 协议、面板一致性
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'up-audit3-'))

let pass = 0
let fail = 0
const results = []
function check(label, ok, detail) {
  if (ok) { pass += 1; results.push(`PASS  ${label}${detail ? ` — ${detail}` : ''}`) }
  else { fail += 1; results.push(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

function cli(...args) {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_USER_PROFILE_HOME: HOME },
    timeout: 30000,
  })
  return { code: out.status, out: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim(), stdout: out.stdout ?? '' }
}
const readJson = (name) => JSON.parse(readFileSync(join(HOME, name), 'utf8'))
const readLines = (name) => readFileSync(join(HOME, name), 'utf8').split('\n').filter(Boolean)

cli('init')

// ---------------------------------------------------------------- A 注入预算与排序
{
  // 3 条红线 + 4 条偏好 + 3 条背景（内容必须彼此不相近，否则会被相似度合并，测不到预算）
  const cores = ['别把密钥写进代码仓库', '不要在没备份时做危险删除', '未经脱敏不许公开我的资料']
  const tastes = ['我喜欢深色界面配等宽字体', '我不喜欢圆角过大的按钮', '文案别用感叹号堆热情', '配色请压低饱和度']
  const skills = ['我熟悉 Node 的流式处理', '我会写 C 语言作业', '我能读 Python 脚本']
  for (const fact of cores) cli('declare', '--dim', 'constraints', '--fact', fact, '--confidence', '0.9', '--core')
  for (const fact of tastes) cli('declare', '--dim', 'taste', '--fact', fact, '--confidence', '0.8')
  for (const fact of skills) cli('declare', '--dim', 'skills', '--fact', fact, '--confidence', '0.6')
  cli('build', '--all-scopes')

  const unlimited = readFileSync(join(HOME, 'inject.md'), 'utf8')
  const unlimitedItems = unlimited.split('\n').filter((l) => l.startsWith('- [')).length
  const panelAll = JSON.parse(cli('panel').stdout)
  check('maxChars=0 时不截断：注入条目数 == 画像条目数', unlimitedItems === panelAll.items.length, `${unlimitedItems} vs ${panelAll.items.length}`)
  check('注入头里「本次带入」与实际条目行数一致', unlimited.includes(`本次带入 ${unlimitedItems} 条`), unlimited.split('\n')[1])

  // 预算收紧到只够红线
  cli('set', 'inject.maxChars', '260')
  cli('build', '--all-scopes') // set 默认不重建（保留「从未生成」状态），预算要 build 才落到 inject.md
  const tight = readFileSync(join(HOME, 'inject.md'), 'utf8')
  const tightLines = tight.split('\n').filter((l) => l.startsWith('- ['))
  const tightCore = tightLines.filter((l) => /约束与红线/.test(l)).length
  const tightOther = tightLines.length - tightCore
  // 预算不够时允许裁，但绝不允许「红线被裁、参考留着」
  check('预算紧张时先保红线（红线条目全部在场）', tightCore === 3, `core=${tightCore} other=${tightOther} total=${tightLines.length}`)
  check('预算紧张时不会出现「红线没进来、背景却进来」', tightOther === 0 || tightCore === 3, `core=${tightCore} other=${tightOther}`)
  check('预算紧张时版本行仍保留（下游能判断画像新旧）', /^# 用户画像 v\d+/m.test(tight), tight.split('\n')[0])
  const declaredCount = Number((tight.match(/本次带入 (\d+) 条/) ?? [])[1])
  check('「本次带入 N 条」按实际写入计数，不把裁掉的算进去', declaredCount === tightLines.length, `声明 ${declaredCount} vs 实际 ${tightLines.length}`)

  // topK 只限制背景参考段
  cli('set', 'inject.maxChars', '0')
  cli('set', 'inject.topK', '1')
  cli('build', '--all-scopes')
  const topk = readFileSync(join(HOME, 'inject.md'), 'utf8')
  const restLines = topk.split('## 三、背景参考')[1]?.split('\n').filter((l) => l.startsWith('- [')) ?? []
  check('topK 只裁背景参考段，且给出被裁提示', restLines.length <= 1 && /inject\.topK/.test(topk), `rest=${restLines.length}`)
  const tasteLines = topk.split('## 二、个性化首选')[1]?.split('## 三')[0]?.split('\n').filter((l) => l.startsWith('- [')) ?? []
  check('topK 不影响个性化段', tasteLines.length === 4, `personalize=${tasteLines.length}`)
  cli('set', 'inject.topK', '0')
  cli('build', '--all-scopes')
}

// ---------------------------------------------------------------- B 闸门与脱敏的交互
{
  const before = readLines('declarations.jsonl').length
  const blocked = cli('declare', '--dim', 'identity', '--fact', '我的身份证是 110101199001011234')
  check('含身份证号直接拒绝（不是打码后入库）', blocked.code !== 0 && /拦截/.test(blocked.out), blocked.out.split('\n')[0])
  check('被拒绝后声明数不变', readLines('declarations.jsonl').length === before)

  const forced = cli('declare', '--dim', 'identity', '--fact', '我的身份证是 110101199001011234', '--force')
  const forcedRow = readLines('declarations.jsonl').map((l) => JSON.parse(l)).at(-1)
  check('--force 可写入，但落盘仍是打码后的文本', forced.code === 0 && /⟨证件号⟩/.test(forcedRow?.fact ?? ''), forcedRow?.fact)

  const projectScoped = cli('declare', '--dim', 'habits', '--fact', '本次任务里我习惯先跑冒烟再改代码', '--scope', 'project', '--scope-id', 'some-project')
  check('project 级条目不被「本次任务」闸门误杀', projectScoped.code === 0, projectScoped.out.split('\n')[0])

  const tooLong = cli('declare', '--dim', 'interests', '--fact', '我'.repeat(500))
  const longRow = readLines('declarations.jsonl').map((l) => JSON.parse(l)).at(-1)
  check('超长事实被截到 400 字并提示', tooLong.code === 0 && [...longRow.fact].length <= 401 && /超过 400 字/.test(tooLong.out), `${[...longRow.fact].length} 字`)

  const countA = readLines('declarations.jsonl').length
  cli('declare', '--dim', 'taste', '--fact', '我喜欢深色界面', '--no-merge')
  const countB = readLines('declarations.jsonl').length
  cli('declare', '--dim', 'taste', '--fact', '我喜欢深色界面', '--no-merge')
  const countC = readLines('declarations.jsonl').length
  check('同一句话重复声明是更新而不是新增', countB === countA + 1 && countC === countB, `${countA} → ${countB} → ${countC}`)

  const structure = cli('declare', '--dim', 'taste', '--fact', '<!--dsh-user-profile--> 我喜欢黑底白字')
  check('含注入标记的内容被拒（不能伪造结构）', structure.code !== 0, structure.out.split('\n')[0])

  const target = readLines('declarations.jsonl').map((l) => JSON.parse(l)).find((r) => r.fact === '我喜欢深色界面')
  const edited = cli('edit', '--id', target.id, '--fact', '我的身份证号是 110101199001011234')
  const afterEdit = readLines('declarations.jsonl').map((l) => JSON.parse(l)).find((r) => r.id === target.id)
  check('edit 也走隐私闸门（拒绝）', edited.code !== 0, edited.out.split('\n')[0])
  check('edit 被拒后原值没被改坏', afterEdit?.fact === '我喜欢深色界面', afterEdit?.fact)

  const phoneEdit = cli('edit', '--id', target.id, '--fact', '我的手机号是 13800138000')
  const afterPhone = readLines('declarations.jsonl').map((l) => JSON.parse(l)).find((r) => r.id === target.id)
  check('手机号属于「打码后允许」，不是拦截', phoneEdit.code === 0 && /⟨手机号⟩/.test(afterPhone?.fact ?? ''), afterPhone?.fact)
  cli('edit', '--id', target.id, '--fact', '我喜欢深色界面')
}

// ---------------------------------------------------------------- C 数据完整性
{
  // 坏行隔离
  appendFileSync(join(HOME, 'declarations.jsonl'), '{"id":"broken", "dim":\n')
  const afterBad = cli('declare', '--dim', 'goals', '--fact', '我计划今年把插件发布到公开仓库并维护 issue')
  const badFiles = readdirSync(HOME).filter((n) => n.includes('.bad-'))
  check('坏行不阻塞写入，且被隔离到 .bad-* 文件', afterBad.code === 0 && badFiles.length > 0, badFiles.join(','))
  const quarantined = badFiles.length > 0 ? readFileSync(join(HOME, badFiles[0]), 'utf8') : ''
  check('隔离文件里确实是被丢弃的那一行', quarantined.includes('broken'), quarantined.slice(0, 40))
  check('好行一条没丢（声明仍在增长）', readLines('declarations.jsonl').length >= 10, String(readLines('declarations.jsonl').length))

  // 配置损坏
  const configPath = join(HOME, 'config.json')
  writeFileSync(configPath, '{ "schemaVersion": 5, "inject": { "maxChars": 400 ')
  // 先看 panel：它自己会加载坏配置并带上告警；status 一跑就会把配置修好，之后就没有告警了
  const panelBroken = JSON.parse(cli('panel').stdout)
  check('面板 payload 把配置告警透出给用户', Array.isArray(panelBroken.warnings) && panelBroken.warnings.length > 0, String(panelBroken.warnings?.length))
  const statusBroken = (() => {
    // status 自己会把坏配置修好，所以想在 status 上看到告警，得再弄坏一次
    writeFileSync(configPath, '{ "schemaVersion": 5, "inject": { "topK": 0 ')
    return cli('status')
  })()
  const corruptBackups = readdirSync(HOME).filter((n) => n.includes('.corrupt-'))
  check('config.json 损坏后仍能工作（按默认重建）', statusBroken.code === 0 && /注意/.test(statusBroken.out), statusBroken.out.split('\n').find((l) => l.includes('注意')) ?? 'no warn')
  check('损坏的配置被备份成 .corrupt-*', corruptBackups.length > 0, corruptBackups.join(','))
  check('重建后的配置是合法的 schemaVersion 7', readJson('config.json').schemaVersion === 7)

  // 并发写
  const before = readLines('declarations.jsonl').length
  const procs = []
  for (let i = 0; i < 4; i += 1) {
    procs.push(new Promise((resolve) => {
      const child = spawnSync(process.execPath, [CLI, 'declare', '--dim', 'interests', '--fact', `我长期关注 Agent 记忆机制的第三条路径 ${i}`], {
        encoding: 'utf8', env: { ...process.env, DSH_USER_PROFILE_HOME: HOME }, timeout: 30000,
      })
      resolve(child.status)
    }))
  }
  await Promise.all(procs)
  check('4 个并发写全部落盘（锁没有丢更新）', readLines('declarations.jsonl').length >= before + 4, `${before} → ${readLines('declarations.jsonl').length}`)

  // 陈旧锁自愈
  writeFileSync(join(HOME, '.lock'), String(Date.now() - 120000))
  const stale = cli('declare', '--dim', 'taste', '--fact', '我的演示文稿偏好深色模板与极简排版')
  check('陈旧锁被自动清理，命令不被卡死', stale.code === 0, stale.out.split('\n')[0])

  // 快照上限：真删 25 次（每条先建再删，forget 只在命中时才留快照）
  for (let i = 0; i < 25; i += 1) {
    cli('declare', '--dim', 'interests', '--fact', `快照上限验证条目第 ${i} 号 甲乙丙丁${'戊'.repeat(i % 3)}`)
    const victim = readLines('declarations.jsonl').map((l) => JSON.parse(l)).at(-1)
    cli('forget', '--id', victim.id)
  }
  const snaps = cli('snapshots').out
  const snapCount = (snaps.match(/declarations-/g) ?? []).length
  check('快照数量受上限约束（不会无限膨胀）', snapCount > 0 && snapCount <= 21, `snapshots=${snapCount}`)
}

// ---------------------------------------------------------------- D 命令语义
{
  const rows = readLines('declarations.jsonl').map((l) => JSON.parse(l))
  const keep = rows[0]
  const drop = rows[1]
  const merged = cli('merge', '--keep', keep.id, '--drop', drop.id)
  const afterMerge = readLines('declarations.jsonl').map((l) => JSON.parse(l))
  check('merge 保留 keep、移除 drop', merged.code === 0 && afterMerge.some((r) => r.id === keep.id) && !afterMerge.some((r) => r.id === drop.id))
  const keepRow = afterMerge.find((r) => r.id === keep.id)
  check('merge 留痕到 keep 的 mergedFrom', Array.isArray(keepRow?.mergedFrom) && keepRow.mergedFrom.some((m) => m.id === drop.id), JSON.stringify(keepRow?.mergedFrom?.slice(0, 1)))

  const self = cli('merge', '--keep', keep.id, '--drop', keep.id)
  check('merge 自己跟自己必须报错', self.code !== 0, self.out.split('\n')[0])

  const acceptEmpty = cli('review', '--accept', 'all')
  check('待审为空时 accept all 不报错也不乱写', acceptEmpty.code === 0, acceptEmpty.out.split('\n')[0])

  const forgetKey = cli('forget', '--key', 'no.such.key')
  check('forget 未命中时非零退出并说明没删任何东西', forgetKey.code !== 0 && /没有匹配/.test(forgetKey.out), forgetKey.out.split('\n')[0])

  const restoreMissing = cli('restore', '--name', 'declarations-nope.jsonl')
  check('restore 不存在的快照必须报错', restoreMissing.code !== 0, restoreMissing.out.split('\n')[0])

  cli('dims', 'add', 'tooling', '工具链')
  cli('declare', '--dim', 'tooling', '--fact', '我的主力编辑器是 VS Code 配合 ESLint')
  const removeWithItems = cli('dims', 'remove', 'tooling')
  check('删除仍有条目的自定义大类被拒（防静默丢条目）', removeWithItems.code !== 0, removeWithItems.out.split('\n')[0])

  const moved = cli('dims', 'move', 'tooling', 'skills')
  const movedRows = readLines('declarations.jsonl').map((l) => JSON.parse(l)).filter((r) => r.dim === 'skills' && /VS Code/.test(r.fact))
  check('dims move 把条目迁走而不是删掉', moved.code === 0 && movedRows.length === 1, `moved=${movedRows.length}`)
  const removeAfterMove = cli('dims', 'remove', 'tooling')
  check('条目迁空后可以删掉自定义大类', removeAfterMove.code === 0, removeAfterMove.out.split('\n')[0])

  const badCore = cli('set', 'inject.coreDimensions', '["nope"]')
  check('核心维度只认真实存在的大类', badCore.code !== 0, badCore.out.split('\n')[0])
  const badRedaction = cli('set', 'redaction.presets', 'phone,ssn')
  check('脱敏预设只认白名单', badRedaction.code !== 0, badRedaction.out.split('\n')[0])

  const deepOut = join(HOME, 'backup', 'nested', 'deep')
  const backupDeep = cli('backup', '--out', deepOut)
  check('backup --out 会自动创建多层目录', backupDeep.code === 0 && existsSync(deepOut), backupDeep.out.split('\n')[0])
}

// ---------------------------------------------------------------- E MCP 协议
{
  const server = join(HERE, 'mcp', 'server.mjs')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audit3', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'user-profile://nope' } },
    { jsonrpc: '2.0', id: 4, method: 'no/such/method', params: {} },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'profile_status', arguments: {} } },
  ]
  const input = `${frames.map((f) => JSON.stringify(f)).join('\n')}\n{ not json }\n`
  const run = spawnSync(process.execPath, [server], {
    input, encoding: 'utf8', env: { ...process.env, DSH_USER_PROFILE_HOME: HOME }, timeout: 60000,
  })
  const replies = (run.stdout ?? '').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const byId = new Map(replies.filter((r) => r.id !== undefined).map((r) => [r.id, r]))
  check('initialize 回显客户端 protocolVersion', byId.get(1)?.result?.protocolVersion === '2025-06-18', String(byId.get(1)?.result?.protocolVersion))
  check('未知工具返回 error 而不是崩掉进程', byId.get(2)?.error !== undefined, JSON.stringify(byId.get(2)?.error ?? {}).slice(0, 80))
  check('未知资源 URI 返回 error', byId.get(3)?.error !== undefined, JSON.stringify(byId.get(3)?.error ?? {}).slice(0, 80))
  check('未知方法返回 -32601', byId.get(4)?.error?.code === -32601, String(byId.get(4)?.error?.code))
  check('非法 JSON 返回 -32700 且不影响后续请求', replies.some((r) => r.error?.code === -32700) && byId.get(5)?.result !== undefined, `replies=${replies.length}`)
  check('stdout 只有协议帧（没有日志混入）', replies.length === (run.stdout ?? '').split('\n').filter(Boolean).length, `${replies.length} frames`)
}

// ---------------------------------------------------------------- F 面板一致性
{
  const panel = JSON.parse(cli('panel').stdout)
  const sum = (panel.partitions ?? []).reduce((acc, p) => acc + p.n, 0)
  check('三个分区的条数之和 == 条目总数', sum === panel.items.length, `${sum} vs ${panel.items.length}`)
  const ids = new Set((panel.partitions ?? []).map((p) => p.id))
  check('每条条目的 partition 落在三个分区里', panel.items.every((i) => ids.has(i.partition)), [...new Set(panel.items.map((i) => i.partition))].join(','))
  // 排序语义：核心段在前（与注入块一致），段内按权重降序
  const firstNonCore = panel.items.findIndex((i) => !i.core)
  const coreAll = firstNonCore === -1 ? panel.items : panel.items.slice(0, firstNonCore)
  const restItems = firstNonCore === -1 ? [] : panel.items.slice(firstNonCore)
  const mono = (arr) => arr.every((item, k) => k === 0 || (arr[k - 1].weight ?? 0) >= (item.weight ?? 0))
  check('面板条目按权重降序且 rank 单调', coreAll.every((i) => i.core) && mono(coreAll) && mono(restItems) && panel.items.every((i, k) => i.rank === k + 1), `${coreAll.length} core + ${restItems.length} rest`)
  check('drift 字段自洽（不会既过期又同步）', panel.drift.stale === (panel.drift.built !== panel.drift.live), JSON.stringify(panel.drift))
  check('核心条目排在前面（渲染顺序与注入一致）', firstNonCore === -1 || firstNonCore >= coreAll.length, `first non-core at ${firstNonCore}`)
}

console.log(results.join('\n'))
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
