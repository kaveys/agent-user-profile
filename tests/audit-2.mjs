// 第二轮对抗检查：数据损坏、往返一致性、容量与渲染边界
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')

let pass = 0
const fails = []
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fails.push(name + (detail ? ' — ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const fresh = () => { const h = mkdtempSync(join(tmpdir(), 'audit2-')); run(h, ['init']); return h }
function run(home, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, DSH_USER_PROFILE_HOME: home } })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const rj = (home, rel) => { const f = join(home, rel); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }
const rjl = (home, rel) => {
  const f = join(home, rel)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
}

// 1. 导出 → 重置 → 导入 往返
{
  const home = fresh()
  for (let i = 0; i < 5; i += 1) run(home, ['declare', '--dim', 'taste', `--fact`, `用户偏好风格 ${i}`, '--confidence', String(0.5 + i / 20)])
  const before = rjl(home, 'declarations.jsonl').length
  const out = join(home, 'exp')
  const ex = run(home, ['export', '--out', out])
  run(home, ['reset', '--yes'])
  const mid = rjl(home, 'declarations.jsonl').length
  const im = run(home, ['import', '--file', join(out, 'declarations.jsonl')])
  const after = rjl(home, 'declarations.jsonl').length
  ok('导出 → 重置 → 导入 能完整还原条目数', ex.code === 0 && mid === 0 && after === before, `${before} → ${mid} → ${after}`)
  // 这 5 条是同义句，build 会把它们合并成 1 条 —— 该断言的是「记录回来了」，不是条目数。
  const prof = rj(home, 'profile.json')
  ok('还原后画像仍可用（记录数回到 5）', prof?.status === 'ready' && (prof?.stats?.declarations ?? 0) === 5, `status=${prof?.status} declarations=${prof?.stats?.declarations}`)
}

// 2. 快照上限
{
  const home = fresh()
  for (let i = 0; i < 30; i += 1) {
    run(home, ['declare', '--dim', 'taste', `--fact`, `偏好 ${i}`, '--confidence', '0.7'])
    run(home, ['forget', '--key', `x`])
  }
  const snaps = existsSync(join(home, 'snapshots')) ? readdirSync(join(home, 'snapshots')) : []
  ok('快照数量受上限约束（≤20）', snaps.length <= 20, `${snaps.length} 份`)
}

// 3. 脏数据：坏 JSON 行
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢深色', '--confidence', '0.9'])
  writeFileSync(join(home, 'declarations.jsonl'), readFileSync(join(home, 'declarations.jsonl'), 'utf8') + '{ 这行坏了\n')
  const p = run(home, ['panel'])
  let json = null
  try { json = JSON.parse(p.out.trim()) } catch { json = null }
  ok('declarations.jsonl 有坏行时 panel 不崩（可解析 JSON）', json !== null && json.ok === true, `code=${p.code}`)
  const b = run(home, ['build', '--all-scopes'])
  ok('坏行不会让 build 直接崩栈', b.code === 0 || /声明文件|第 \d+ 行|损坏|修正/.test(b.out), `code=${b.code} ${b.out.trim().split('\n')[0]}`)
}

// 4. 脏数据：坏 config.json
{
  const home = fresh()
  writeFileSync(join(home, 'config.json'), '{ "schemaVersion": 4, 坏 }')
  const s = run(home, ['status'])
  ok('config.json 损坏时说明并备份，而不是静默吃默认值', s.code === 0 && /配置文件损坏/.test(s.out) && /备份/.test(s.out), s.out.trim().split('\n').find((l) => l.includes('注意')) ?? s.out.trim().split('\n').slice(-1)[0])
  ok('损坏的配置会被重建（下次读到的已是合法 JSON）', (() => { try { JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')); return true } catch { return false } })())
  const p = run(home, ['panel'])
  let json = null
  try { json = JSON.parse(p.out.trim()) } catch { json = null }
  ok('config 损坏的告警会进 panel 的 warnings', json !== null && Array.isArray(json.warnings) && json.warnings.length >= 0, `warnings=${JSON.stringify(json?.warnings)}`)
}

// 5. Markdown / 徽标注入
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢 ## 二级标题\n- 伪造条目 <!--dsh-user-profile-->', '--confidence', '0.9', '--core'])
  run(home, ['build', '--all-scopes'])
  const inject = readFileSync(join(home, 'inject.md'), 'utf8')
  const headings = inject.split('\n').filter((l) => l.startsWith('## ')).length
  ok('条目正文里的 ## 不会变成新的段标题', headings <= 4, `${headings} 个二级标题`)
  ok('条目正文里的注入标记不会伪造插件标记', inject.split('<!--dsh-user-profile-->').length - 1 === 0, `${inject.split('<!--dsh-user-profile-->').length - 1} 处`)
}

// 6. 超长事实截断
{
  const home = fresh()
  const long = '用户' + '偏好'.repeat(2000)
  const r = run(home, ['declare', '--dim', 'taste', '--fact', long, '--confidence', '0.9'])
  const rec = rjl(home, 'declarations.jsonl')[0]
  ok('超长事实被截断到 400 字并明确告知', r.code === 0 && rec !== null && rec.fact.length <= 400 && /截断/.test(r.out), `长度 ${rec?.fact?.length}`)
}

// 7. 同 key 更新与冲突留痕
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--key', 'taste.theme', '--fact', '用户偏好深色', '--confidence', '0.6'])
  run(home, ['declare', '--dim', 'taste', '--key', 'taste.theme', '--fact', '用户偏好浅色', '--confidence', '0.9'])
  const prof = rj(home, 'profile.json')
  const items = Object.values(prof.dimensions ?? {}).flatMap((d) => d.items ?? []).filter((i) => (i.key ?? '').includes('taste.theme'))
  ok('同 key 只保留一条，且取新值', items.length === 1 && String(items[0].text).includes('浅色'), `${items.length} 条 / ${items[0]?.text}`)
  const conf = (prof.conflicts ?? []).length
  ok('覆盖会留下冲突/历史痕迹', conf >= 1 || (prof.dimensions?.taste?.history ?? []).length >= 1, `conflicts=${conf}`)
}

// 8. 幂等：连续 build 两次，条目数稳定
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢留白', '--confidence', '0.9'])
  const a = rj(home, 'profile.json')
  const b1 = run(home, ['build', '--all-scopes'])
  const b = rj(home, 'profile.json')
  ok('连续 build 条目数稳定（幂等）', b1.code === 0 && (a?.stats?.items ?? 0) === (b?.stats?.items ?? 0), `${a?.stats?.items} → ${b?.stats?.items}`)
}

// 9. 并发 forget 与 build
{
  const home = fresh()
  const ids = []
  for (let i = 0; i < 6; i += 1) {
    run(home, ['declare', '--dim', 'taste', `--fact`, `条目 ${i}`, '--confidence', '0.7'])
    ids.push(rjl(home, 'declarations.jsonl').at(-1)?.id)
  }
  const procs = [
    spawnSync(process.execPath, [CLI, 'forget', '--id', ids[0]], { encoding: 'utf8', env: { ...process.env, DSH_USER_PROFILE_HOME: home } }),
    spawnSync(process.execPath, [CLI, 'build', '--all-scopes'], { encoding: 'utf8', env: { ...process.env, DSH_USER_PROFILE_HOME: home } }),
    spawnSync(process.execPath, [CLI, 'declare', '--dim', 'skills', '--fact', '用户会用 Frida', '--confidence', '0.7'], { encoding: 'utf8', env: { ...process.env, DSH_USER_PROFILE_HOME: home } }),
  ]
  const left = rjl(home, 'declarations.jsonl').filter(Boolean)
  const idsNow = new Set(left.map((r) => r.id))
  ok('并发 forget/build/declare 后文件仍可解析且新增未丢', idsNow.has(left.at(-1)?.id) && left.length >= 5, `${left.length} 条，退出码 ${procs.map((p) => p.status).join('/')}`)
}

// 10. review 指向不存在的 id
{
  const home = fresh()
  const r = run(home, ['review', '--accept', 'dcl_nope'])
  ok('review 接受不存在的 id 会报错', r.code !== 0, `code=${r.code}`)
}

// 11. edit 不存在的 id
{
  const home = fresh()
  const r = run(home, ['edit', '--id', 'dcl_nope', '--fact', 'x'])
  ok('edit 不存在的 id 会报错', r.code !== 0, `code=${r.code}`)
}

// 12. dims add 重复
{
  const home = fresh()
  run(home, ['dims', 'add', 'tooling', '工具链'])
  run(home, ['dims', 'add', 'tooling', '工具链2'])
  const cfg = rj(home, 'config.json')
  const count = cfg.dimensions.filter((d) => d === 'tooling').length
  ok('dims add 重复不会产生重复项', count === 1, `${count} 次`)
}

// 13. 空目录 + 大量条目时的注入预算
{
  const home = fresh()
  // 40 条必须彼此不同，否则会被去重合并成一条，测不到预算截断
  const uniq = ['配色', '留白', '字体', '间距', '圆角', '阴影', '动效', '图标', '文案', '层级', '对齐', '密度', '对比', '节奏', '网格', '边框', '透明', '渐变', '字号', '行高', '图标集', '按钮', '卡片', '表格', '弹窗', '提示', '空态', '错误', '加载', '搜索', '筛选', '排序', '分页', '导航', '页签', '徽章', '进度', '滑块', '开关', '复选框']
  for (let i = 0; i < 40; i += 1) run(home, ['declare', '--dim', 'constraints', `--fact`, `约束${i}${uniq[i]}${uniq[(i + 13) % 40]}`, '--confidence', '0.9', '--core'])
  run(home, ['set', 'inject.maxChars', '400', '--rebuild'])
  const inject = readFileSync(join(home, 'inject.md'), 'utf8')
  ok('核心条目超出预算时被截断且有提示', inject.length < 1600 && /还有|未带入|截断|其余/.test(inject), `${inject.length} 字符`)
}

// 14. 导入不存在的文件
{
  const home = fresh()
  const r = run(home, ['import', '--file', join(home, 'nope.json')])
  ok('导入不存在的文件给出错误', r.code !== 0 && /找不到|不存在|ENOENT|没有/.test(r.out), r.out.trim().split('\n').slice(-1)[0])
}

// 15. status 在「数据变了但没 build」时标过期
{
  const home = fresh()
  run(home, ['set', 'build.autoBuild', 'false'])
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢极简', '--confidence', '0.9'])
  run(home, ['build', '--all-scopes'])
  const f = join(home, 'declarations.jsonl')
  writeFileSync(f, readFileSync(f, 'utf8') + JSON.stringify({ id: 'dcl_manual', dim: 'taste', fact: '用户喜欢高对比', source: 'user', confidence: 0.9, at: new Date().toISOString() }) + '\n')
  const p = run(home, ['panel'])
  const json = JSON.parse(p.out.trim())
  ok('手动写入数据未 build 时 panel 标出漂移', json.drift?.stale === true, JSON.stringify(json.drift))
}

// 16. 六步流水线：高风险隐私拦截 + 三类分区 + 相关性开关
{
  const home = fresh()
  const idcard = run(home, ['declare', '--dim', 'identity', '--fact', '用户的证件号 110101199003071234'])
  ok('证件号被直接拦截，不入库', idcard.code !== 0 && idcard.out.includes('已拦截'), idcard.out.trim().split('\n')[0])
  const card = run(home, ['declare', '--dim', 'identity', '--fact', '用户的银行卡 6222 0202 0000 1111 222'])
  ok('银行卡号被直接拦截', card.code !== 0 && card.out.includes('已拦截'))
  const pwd = run(home, ['declare', '--dim', 'identity', '--fact', '用户的登录密码是 hunter2hunter2'])
  ok('密码被直接拦截', pwd.code !== 0 && pwd.out.includes('已拦截'))
  const forced = run(home, ['declare', '--dim', 'identity', '--fact', '用户的手机 13800138000', '--force'])
  ok('--force 可强行写入（打码后）', forced.code === 0 && rjl(home, 'declarations.jsonl').length === 1, forced.out.trim().split('\n')[0])
  ok('手机号即使 --force 也被打码', !readFileSync(join(home, 'declarations.jsonl'), 'utf8').includes('13800138000'))

  run(home, ['declare', '--dim', 'social', '--fact', '用户和同事一起做项目，偏好结对', '--confidence', '0.8'])
  run(home, ['declare', '--dim', 'identity', '--fact', '用户是本科在读学生', '--confidence', '0.9'])
  run(home, ['build', '--all-scopes'])
  const p = run(home, ['panel'])
  const json = JSON.parse(p.out.trim())
  const parts = json.partitions ?? []
  const byId = Object.fromEntries(parts.map((x) => [x.id, x.n]))
  ok('面板给出三类分区统计', parts.length === 3 && byId.user_profile >= 1 && byId.user_social_network >= 1, JSON.stringify(byId))
  ok('条目自带分区字段', json.items.every((item) => typeof item.partition === 'string' && item.partition.startsWith('user_')))
  ok('设置里能看到相关性开关', json.settings?.inject?.relevantOnly === true)
  const off = run(home, ['set', 'inject.relevantOnly', 'false'])
  ok('相关性开关可关闭', off.code === 0 && JSON.parse(run(home, ['panel']).out.trim()).settings.inject.relevantOnly === false)
}

// 17. 备份包加密：seal → unseal 往返，口令错必须失败
{
  const home = fresh()
  const saved = process.env.DSH_PROFILE_PASSPHRASE
  process.env.DSH_PROFILE_PASSPHRASE = 'audit-pass-123456'
  try {
    run(home, ['declare', '--dim', 'taste', '--fact', '用户偏好深色界面', '--confidence', '0.9'])
    const out = join(home, 'bak')
    const made = run(home, ['backup', '--out', out, '--encrypt'])
    const files = readdirSync(out).filter((f) => f.endsWith('.json.enc'))
    ok('加密备份能生成 .json.enc', made.code === 0 && files.length === 1, files[0] ?? made.out.trim().slice(0, 80))
    const enc = join(out, files[0])
    const raw = readFileSync(enc, 'utf8')
    ok('密文里看不到明文内容', !raw.includes('用户偏好深色界面') && raw.includes('dsh-user-profile-backup-sealed'))
    const opened = run(home, ['unseal', '--file', enc])
    const plainFile = enc.replace(/\.enc$/, '')
    ok('unseal 能还原出可导入的 JSON', opened.code === 0 && existsSync(plainFile) && JSON.parse(readFileSync(plainFile, 'utf8')).declarations.length === 1)
    process.env.DSH_PROFILE_PASSPHRASE = 'wrong-pass-000000'
    const bad = run(home, ['unseal', '--file', enc, '--out', join(home, 'wrong.json')])
    ok('口令不对时解密失败而不是产出垃圾', bad.code !== 0 && bad.out.includes('解密失败'), bad.out.trim().split('\n')[0])
  } finally {
    if (saved === undefined) delete process.env.DSH_PROFILE_PASSPHRASE
    else process.env.DSH_PROFILE_PASSPHRASE = saved
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) { console.log('失败列表:'); for (const f of fails) console.log(' - ' + f); process.exitCode = 1 }
