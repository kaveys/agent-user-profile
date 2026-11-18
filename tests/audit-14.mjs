/**
 * 第十四轮排查 —— 三个冷启动子智能体（新用户 / 代码审计 / 隐私契约）交上来的缺陷复盘。
 *
 * 这一轮的共同点还是「退出码 0、界面不报错」，但后果比上一轮重：
 *   - dedupe --apply 会把「先放下」的记录整批永久删除（静默丢数据）；
 *   - 备份导出→回灌之后，置顶、保质期、项目作用域全没了；
 *   - 一条全局偏好被同义合并进某个项目的条目，从此在别的项目里消失；
 *   - merge 把更可信的 0.95 改成 0.4，且不留快照；
 *   - 面板「批量删除 / 批量设为核心」永远失败，还提示「已删除 N 条」；
 *   - --excerpt 与 redact 都不管 provenance.excerpt，密码/证件号能从旁路进库；
 *   - sk- 密钥正则不认连字符；--confidence 越界静默夹取；命令行帮助是空壳。
 *
 * 覆盖：
 *   T1  dedupe --apply 不许碰「先放下」的行
 *   T2  import 还原 pinnedAt / expiresAt / scope
 *   T3  同义合并的作用域取宽者（global 不会被并成 project）
 *   T4  merge 取更高置信度、更晚保质期，并留快照
 *   T5  面板语义的批量接口（--ids）在 CLI 与宿主两端都通
 *   T6  --excerpt 含证件号/密码时不落盘
 *   T7  redact 会扫 provenance.excerpt
 *   T8  sk- 密钥带连字符也能脱敏
 *   T9  help 与 <命令> --help 都有实质内容
 *   T10 show --with-keys 能拿到 key / id
 *   T11 --confidence 越界报错，不静默夹取
 *   T12 MCP profile_search 不返回已放下 / 已过期的条目
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const MCP = join(HERE, 'mcp', 'server.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-a14-'))
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
const cliFail = (args) => {
  try {
    execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: HERE, stdio: 'pipe' })
    return { ok: true, text: '' }
  } catch (error) {
    return { ok: false, text: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}
const read = (name) => readFileSync(join(HOME, name), 'utf8')
const rows = () => read('declarations.jsonl').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))

cli(['init'])

// ---------------------------------------------------------------- T1
cli(['declare', '--dim', 'taste', '--fact', '喜欢极简的界面风格', '--key', 'ui.style'])
cli(['declare', '--dim', 'taste', '--fact', '喜欢简洁干净的界面设计', '--key', 'ui.style2'])
cli(['declare', '--dim', 'social', '--fact', '和同事一起维护开源仓库', '--key', 'team'])
cli(['retire', '--dim', 'social'])
cli(['dedupe', '--apply'])
const afterDedupe = rows()
check('T1 dedupe 不删除「先放下」的记录', afterDedupe.length === 2 && afterDedupe.some((row) => row.retiredAt !== undefined),
  `${afterDedupe.length} 行，其中已放下 ${afterDedupe.filter((row) => row.retiredAt !== undefined).length} 行`)

// ---------------------------------------------------------------- T2
cli(['declare', '--dim', 'taste', '--fact', '偏好深色主题的编辑器', '--key', 'ui.theme'])
cli(['pin', '--key', 'ui.theme'])
cli(['declare', '--dim', 'constraints', '--fact', '回复里不要用表情符号', '--key', 'no.emoji', '--ttl', '5d'])
cli(['declare', '--dim', 'work', '--fact', '这个仓库用 pnpm 管依赖', '--key', 'pkg.mgr', '--scope', 'project', '--scope-id', 'proj-A'])
const exportDir = mkdtempSync(join(tmpdir(), 'dsh-profile-a14-export-'))
cli(['export', '--out', exportDir])
cli(['import', '--file', join(exportDir, 'declarations.jsonl')])
const imported = rows().filter((row) => typeof row.importedFrom === 'string')
const importedTheme = imported.find((row) => row.key === 'ui.theme')
const importedTtl = imported.find((row) => row.key === 'no.emoji')
const importedScope = imported.find((row) => row.key === 'pkg.mgr')
check('T2a import 还原置顶', importedTheme?.pinnedAt !== undefined, `pinnedAt=${importedTheme?.pinnedAt ?? '缺失'}`)
check('T2b import 还原保质期', importedTtl?.expiresAt !== undefined, `expiresAt=${importedTtl?.expiresAt ?? '缺失'}`)
check('T2c import 还原项目作用域', importedScope?.scope === 'project' && importedScope?.scopeId === 'proj-A',
  `scope=${importedScope?.scope} scopeId=${importedScope?.scopeId}`)

// ---------------------------------------------------------------- T3
cli(['declare', '--dim', 'work', '--fact', '偏好用 pnpm 管理依赖', '--scope', 'project', '--scope-id', 'proj-B'])
cli(['declare', '--dim', 'work', '--fact', '偏好用 pnpm 来管理依赖'])
const pnpmRows = rows().filter((row) => String(row.fact).includes('偏好用 pnpm'))
const projectPnpm = rows().filter((row) => String(row.fact).includes('这个仓库用 pnpm'))
check('T3 同义合并作用域取宽者（不把全局并成单项目）',
  pnpmRows.length === 1 && pnpmRows[0].scope === 'global' && projectPnpm.every((row) => row.scope === 'project'),
  `合并后 ${pnpmRows.length} 条（scope=${pnpmRows[0]?.scope ?? '无'}），项目条目 ${projectPnpm.length} 条仍为 project`)

// ---------------------------------------------------------------- T4
cli(['declare', '--dim', 'interests', '--fact', '喜欢看航空类纪录片', '--key', 'doc.air', '--confidence', '0.4'])
cli(['declare', '--dim', 'interests', '--fact', '平时爱看航空题材的纪录片', '--key', 'doc.air2', '--confidence', '0.95', '--ttl', '5d'])
const beforeMerge = rows().filter((row) => ['doc.air', 'doc.air2'].includes(row.key))
const snapBefore = existsSync(join(HOME, 'snapshots')) ? readdirSync(join(HOME, 'snapshots')).length : 0
cli(['merge', '--keep', beforeMerge[0].id, '--drop', beforeMerge[1].id])
const afterMerge = rows().filter((row) => ['doc.air', 'doc.air2'].includes(row.key))
const snapAfter = existsSync(join(HOME, 'snapshots')) ? readdirSync(join(HOME, 'snapshots')).length : 0
check('T4a merge 保留更高置信度', Number(afterMerge[0]?.confidence) === 0.95, `confidence=${afterMerge[0]?.confidence}`)
check('T4b merge 保留更晚的保质期', afterMerge[0]?.expiresAt !== undefined, `expiresAt=${afterMerge[0]?.expiresAt ?? '缺失'}`)
check('T4c merge 写盘前留快照', snapAfter > snapBefore, `快照 ${snapBefore} → ${snapAfter}`)

// ---------------------------------------------------------------- T5
const bulkIds = rows().slice(0, 2).map((row) => row.id).join(',')
cli(['retire', '--ids', bulkIds])
cli(['unretire', '--ids', bulkIds])
const hostSource = readFileSync(join(HERE, 'index.js'), 'utf8')
const clientSource = readFileSync(join(HERE, 'client.js'), 'utf8')
check('T5a CLI 批量 --ids 可用', rows().filter((row) => bulkIds.split(',').includes(row.id)).every((row) => row.retiredAt === undefined))
check('T5b 宿主 forget/edit 透传 ids', /forget\(input\)[\s\S]{0,400}--ids/.test(hostSource) && /edit\(input\)[\s\S]{0,500}--ids/.test(hostSource))
check('T5c 面板失败不再提示成功', clientSource.includes('result?.ok === false'))

// ---------------------------------------------------------------- T6
cli(['declare', '--dim', 'communication', '--fact', '用户喜欢深色模式', '--key', 'ui.dark',
  '--excerpt', '我的密码是 Abc12345!，身份证 110101199001011234'])
const excerptRow = rows().find((row) => row.key === 'ui.dark')
const excerptText = String(excerptRow?.provenance?.excerpt ?? '')
check('T6 带证件号/密码的 excerpt 不落盘', !excerptText.includes('110101') && !excerptText.includes('Abc12345'), `excerpt=${JSON.stringify(excerptText)}`)

// ---------------------------------------------------------------- T7
const t7File = join(HOME, 'declarations.jsonl')
const t7Rows = rows()
t7Rows.push({
  id: 'dcl_manual_t7',
  at: new Date().toISOString(),
  dim: 'communication',
  key: 'legacy.leak',
  fact: '用户常用邮箱是 someone@example.com',
  source: 'user',
  confidence: 1,
  provenance: { kind: 'user', at: new Date().toISOString(), excerpt: '原话：我的邮箱 someone@example.com' },
})
writeFileSync(t7File, `${t7Rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
const redactOut = cli(['redact', '--apply'])
const t7After = rows().find((row) => row.id === 'dcl_manual_t7')
check('T7 redact 会扫 provenance.excerpt', !String(t7After?.provenance?.excerpt ?? '').includes('someone@example.com'),
  `${redactOut.trim().split('\n').pop()} / excerpt=${JSON.stringify(t7After?.provenance?.excerpt ?? '')}`)

// ---------------------------------------------------------------- T8
cli(['declare', '--dim', 'constraints', '--fact', '密钥 sk-test-1234567890abcdefgh 要保密', '--key', 'sec.key'])
const skRow = rows().find((row) => row.key === 'sec.key')
check('T8 sk- 密钥带连字符也能脱敏', !String(skRow?.fact ?? '').includes('sk-test-1234567890abcdefgh'), `fact=${JSON.stringify(skRow?.fact ?? '')}`)

// ---------------------------------------------------------------- T9
const helpOut = cli(['help'])
const declareHelp = cli(['declare', '--help'])
check('T9a help 列命令并带一句话说明', helpOut.split('\n').filter((line) => line.trim().startsWith('init')).length === 1 && helpOut.includes('准备数据目录'))
check('T9b <命令> --help 有用法', declareHelp.includes('用法：') && declareHelp.includes('--fact'))

// ---------------------------------------------------------------- T10
const withKeys = cli(['show', '--with-keys'])
check('T10 show --with-keys 给出 key 与 id', withKeys.includes('key=') && withKeys.includes('id='))

// ---------------------------------------------------------------- T11
const badConfidence = cliFail(['declare', '--dim', 'taste', '--fact', '测试越界置信度', '--confidence', '2'])
check('T11 --confidence 越界报错', badConfidence.ok === false && badConfidence.text.includes('--confidence'), badConfidence.text.trim().split('\n').pop())

// ---------------------------------------------------------------- T12
cli(['declare', '--dim', 'taste', '--fact', '偏好极简界面风格', '--key', 't12'])
cli(['retire', '--key', 't12'])
const mcpReply = await new Promise((resolve) => {
  const child = spawn(process.execPath, [MCP], { env, cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`)
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (const line of buffer.split('\n')) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id === 2) { child.kill(); resolve(JSON.stringify(message)); return }
    }
  })
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit-14', version: '1' } } })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'profile_search', arguments: { query: '极简界面' } } })
  setTimeout(() => { child.kill(); resolve('{}') }, 20000)
})
check('T12 MCP search 不返回已放下条目', !mcpReply.includes('t12') && !mcpReply.includes('偏好极简界面风格'), mcpReply.slice(0, 120))
// T13：注入前按项目过滤（v37）。别的项目的细节不能进这一轮的注入块。
const { filterForeignScope } = await import(pathToFileURL(join(HERE, 'index.js')).href)
const sample = [
  '# 用户画像',
  '## 一、红线与硬要求',
  '- [约束与红线 1 · 已确认] 对外上传前必须彻底脱敏',
  '## 三、背景参考',
  '- [已确认 0.6 · project:proj-A] 这个仓库用 pnpm 管依赖',
  '- [已确认 0.6 · project:proj-B] 那个仓库用 yarn 管依赖',
  '- [已确认 0.6 · 已确认] 用户偏好短句',
].join('\n')
const filteredA = filterForeignScope(sample, 'proj-A')
const filteredB = filterForeignScope(sample, 'proj-B')
check('T13a 注入前丢掉别的项目的条目', filteredA.dropped === 1 && filteredA.text.includes('pnpm') && !filteredA.text.includes('yarn'), `dropped=${filteredA.dropped}`)
check('T13b 全局与红线永不过滤', filteredA.text.includes('短句') && filteredA.text.includes('脱敏') && filteredB.text.includes('yarn'), `A=${filteredA.text.length} B=${filteredB.text.length}`)
console.log(`\n第十四轮排查：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
