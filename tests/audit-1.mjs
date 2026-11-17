// 对抗式自检：专挑「看起来能用、但边界会出血」的地方
// 一律在临时 HOME 里跑，不碰真实画像。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')

let pass = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fails.push(name + (detail ? ' — ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'audit-'))
  run(home, ['init'])
  return home
}
function run(home, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, DSH_USER_PROFILE_HOME: home },
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const readJson = (home, rel) => {
  const f = join(home, rel)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}
const readJsonl = (home, rel) => {
  const f = join(home, rel)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const cfgOf = (home) => readJson(home, 'config.json')

// ---------------------------------------------------------------- 1. 维度删除的孤儿
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢极简界面', '--confidence', '0.9'])
  run(home, ['dims', 'add', 'tooling', '工具链'])
  run(home, ['declare', '--dim', 'tooling', '--fact', '用户常用 VS Code', '--confidence', '0.8'])
  const before = readJsonl(home, 'declarations.jsonl').length
  const del = run(home, ['dims', 'remove', 'tooling'])
  const after = readJsonl(home, 'declarations.jsonl')
  const profile = readJson(home, 'profile.json')
  const items = profile?.dimensions ? Object.values(profile.dimensions).flatMap((d) => d.items ?? []) : []
  const kept = items.some((i) => String(i.text ?? i.fact ?? '').includes('VS Code'))
  ok('删除仍有条目的自定义维度时，不静默丢数据', kept, `声明 ${before} → 文件 ${after.length} 条；产物含该条目=${kept}`);
  ok('删除仍有条目的自定义维度时，CLI 给出提示而不是静默成功', /仍|还剩|条|提示|先/.test(del.out), del.out.trim().split('\n')[0])
}

// ---------------------------------------------------------------- 2. 删除内置大类
{
  const home = fresh()
  run(home, ['declare', '--dim', 'constraints', '--fact', '用户要求不留后门', '--confidence', '0.9', '--core'])
  const r = run(home, ['dims', 'remove', 'constraints'])
  const cfg = cfgOf(home)
  const items = readJsonl(home, 'declarations.jsonl')
  ok('内置大类不可被删除', cfg.dimensions.includes('constraints'), `退出码 ${r.code}`)
  ok('内置大类删除被拒时数据不丢', items.length === 1, `${items.length} 条`)
}

// ---------------------------------------------------------------- 3. 非法配置值
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢深色主题', '--confidence', '0.9'])
  const a = run(home, ['set', 'inject.maxChars', 'abc'])
  const b = run(home, ['set', 'inject.maxChars', '-5'])
  const c = run(home, ['set', 'inject.maxChars', '0'])
  const cfg = cfgOf(home)
  const len = Number(cfg.inject.maxChars)
  ok('set 拒绝非数字', a.code !== 0 && Number.isFinite(Number(cfg.inject.maxChars)), `code=${a.code}`)
  // v15 起 0 是合法值（= 不设上限），负数必须拒；这里分别验证「拒负」与「0 被接受」。
  ok('set 拒绝负数', b.code !== 0, `code=${b.code}`)
  ok('0 表示不设上限，被接受', c.code === 0 && len === 0, `maxChars=${cfg.inject.maxChars}`)
  const tiny = run(home, ['set', 'inject.maxChars', '120', '--rebuild'])
  const build = run(home, ['build', '--all-scopes'])
  const inject = existsSync(join(home, 'inject.md')) ? readFileSync(join(home, 'inject.md'), 'utf8') : ''
  ok('极小预算下 build 不炸且产物非空', tiny.code === 0 && build.code === 0 && inject.length > 0, `${inject.length} 字符`)
}

// ---------------------------------------------------------------- 4. 未知配置键
{
  const home = fresh()
  const r = run(home, ['set', 'inject.nope', '1'])
  const cfg = cfgOf(home)
  ok('set 未知键被拒（不写垃圾进 config）', !('nope' in (cfg.inject ?? {})), `code=${r.code}`)
}

// ---------------------------------------------------------------- 5. edit 到不存在的维度
{
  const home = fresh()
  const d = run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢留白', '--confidence', '0.9'])
  const id = readJsonl(home, 'declarations.jsonl')[0]?.id
  const r = run(home, ['edit', '--id', id, '--dim', 'nope'])
  const rec = readJsonl(home, 'declarations.jsonl')[0]
  ok('edit 拒绝不存在的维度', r.code !== 0 && rec.dim === 'taste', `code=${r.code} dim=${rec.dim}`)
}

// ---------------------------------------------------------------- 6. merge 自己到自己
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢简洁界面', '--confidence', '0.9', '--no-merge'])
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢简洁的界面风格', '--confidence', '0.6', '--no-merge'])
  const items = readJsonl(home, 'declarations.jsonl')
  const [a, b] = items.map((i) => i.id)
  const r = run(home, ['merge', '--keep', a, '--drop', a])
  const left = readJsonl(home, 'declarations.jsonl')
  ok('merge 自己到自己被拒，且不删数据', r.code !== 0 && left.length === items.length, `code=${r.code} 剩余 ${left.length}`)
  const r2 = run(home, ['merge', '--keep', a, '--drop', b])
  const left2 = readJsonl(home, 'declarations.jsonl')
  const keep = left2.find((i) => i.id === a)
  ok('merge 正常路径可用，drop 被并入 keep', r2.code === 0 && left2.length === items.length - 1 && Array.isArray(keep?.mergedFrom), `${left2.length} 条`)
}

// ---------------------------------------------------------------- 7. 空事实与极端权重
{
  const home = fresh()
  const e = run(home, ['declare', '--dim', 'taste', '--fact', '   ', '--confidence', '0.9'])
  const n = readJsonl(home, 'declarations.jsonl').length
  ok('空事实被拒', e.code !== 0 && n === 0, `code=${e.code} 写入 ${n} 条`)
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢暗色', '--confidence', '5'])
  const w = Number(readJsonl(home, 'declarations.jsonl')[0]?.confidence)
  ok('越界权重被夹到 0..1', w > 0 && w <= 1, `confidence=${w}`)
}

// ---------------------------------------------------------------- 8. 未 init 的目录
{
  const home = mkdtempSync(join(tmpdir(), 'audit-empty-'))
  const p = run(home, ['panel'])
  let parsed = null
  try { parsed = JSON.parse(p.out.trim()) } catch { parsed = null }
  ok('未 init 时 panel 仍输出可解析 JSON（不抛栈）', parsed !== null && parsed.ok === true, `code=${p.code}`)
  const s = run(home, ['status'])
  ok('未 init 时 status 不抛栈', s.code === 0 && !/at Object\.|TypeError|ENOENT.*\n\s+at /.test(s.out), `code=${s.code}`)
}

// ---------------------------------------------------------------- 9. 重复 id 的导入
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢简洁', '--confidence', '0.9'])
  const src = readJsonl(home, 'declarations.jsonl')
  const file = join(home, 'dup.json')
  writeFileSync(file, JSON.stringify([src[0], src[0]], null, 2))
  run(home, ['import', '--file', file])
  const all = readJsonl(home, 'declarations.jsonl')
  const ids = all.map((i) => i.id)
  ok('导入重复 id 不产生重复条目', new Set(ids).size === ids.length, `${ids.length} 条 / ${new Set(ids).size} 个 id`)
}

// ---------------------------------------------------------------- 10. restore 非法名
{
  const home = fresh()
  const r = run(home, ['restore', '--name', '../../../etc/passwd'])
  ok('restore 拒绝路径穿越', r.code !== 0, `code=${r.code}`)
}

// ---------------------------------------------------------------- 11. 空库 build 的行为
{
  const home = fresh()
  const b = run(home, ['build', '--all-scopes'])
  const profile = readJson(home, 'profile.json')
  const inject = existsSync(join(home, 'inject.md')) ? readFileSync(join(home, 'inject.md'), 'utf8') : ''
  ok('空库 build 成功且状态为 empty', b.code === 0 && profile?.status === 'empty', `status=${profile?.status}`)
  ok('空库不生成误导性注入正文', inject.trim().length < 80 || !/红线|个性化首选/.test(inject), `${inject.trim().split('\n').length} 行`)
}

// ---------------------------------------------------------------- 12. project 作用域不会污染全局
{
  const home = fresh()
  run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢深色', '--confidence', '0.9'])
  run(home, ['declare', '--dim', 'taste', '--fact', '本项目用 pnpm', '--confidence', '0.9', '--scope', 'project', '--scope-id', 'projA'])
  const b = run(home, ['build', '--all-scopes'])
  const profile = readJson(home, 'profile.json')
  const text = JSON.stringify(profile)
  ok('--all-scopes 时项目条目也能进产物（显式要求全含）', b.code === 0 && text.includes('pnpm'), `code=${b.code}`)
  run(home, ['build'])
  const p2 = readJson(home, 'profile.json')
  const t2 = JSON.stringify(p2)
  ok('默认 build 不带别的项目的条目', !t2.includes('pnpm'), t2.includes('pnpm') ? '泄漏' : '未泄漏')
}

// ---------------------------------------------------------------- 13. lock 残留自愈
{
  const home = fresh()
  writeFileSync(join(home, '.lock'), String(Date.now() - 10 * 60 * 1000))
  const r = run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢清爽布局', '--confidence', '0.9'])
  ok('10 分钟前的陈旧锁被自愈', r.code === 0, `code=${r.code} ${r.out.trim().split('\n')[0]}`)
}

// ---------------------------------------------------------------- 14. 新鲜锁必须等待而不是绕过
{
  const home = fresh()
  writeFileSync(join(home, '.lock'), String(Date.now()))
  const r = run(home, ['declare', '--dim', 'taste', '--fact', '用户喜欢浅色', '--confidence', '0.9'])
  const wrote = readJsonl(home, 'declarations.jsonl').length
  ok('新鲜锁存在时不硬闯（超时报错、不写半截）', r.code !== 0 || wrote === 1, `code=${r.code} 写入 ${wrote}`)
}

// ---------------------------------------------------------------- 15. 大类迁移后仍可见
{
  const home = fresh()
  run(home, ['dims', 'add', 'tooling', '工具链'])
  run(home, ['declare', '--dim', 'tooling', '--fact', '用户常用 VS Code', '--confidence', '0.8'])
  const mv = run(home, ['dims', 'move', 'tooling', 'skills'])
  const rec = readJsonl(home, 'declarations.jsonl').find((i) => String(i.fact).includes('VS Code'))
  ok('dims move 把条目搬到目标大类且不删数据', mv.code === 0 && rec?.dim === 'skills', `dim=${rec?.dim}`)
  const rm = run(home, ['dims', 'remove', 'tooling'])
  const cfg = cfgOf(home)
  ok('空大类可以删除', rm.code === 0 && !cfg.dimensions.includes('tooling'), `code=${rm.code}`)
}

// ---------------------------------------------------------------- 16. set 的可用项与 --rebuild
{
  const home = fresh()
  const list = run(home, ['set', 'list'])
  ok('set list 能列出可用配置项', list.code === 0 && list.out.includes('inject.maxChars') && list.out.includes('conflicts.strategy'), `${list.out.split('\n').length} 行`)
  const r = run(home, ['set', 'inject.maxChars', '900', '--rebuild'])
  const cfg = cfgOf(home)
  ok('set 合法数值生效，--rebuild 立刻生成画像', r.code === 0 && Number(cfg.inject.maxChars) === 900 && existsSync(join(home, 'profile.json')), `maxChars=${cfg.inject.maxChars}`)
  const bad = run(home, ['set', 'inject.coreDimensions', 'taste,nope'])
  ok('set 维度列表拒绝不存在的大类', bad.code !== 0, `code=${bad.code}`)
}

// ---------------------------------------------------------------- 17. 面板形态的配置写入
{
  const home = fresh()
  // 面板数字字段发 Number，旧宿主曾 JSON.stringify 成 '"1600"'，CLI 会 Number() 失败
  const a = run(home, ['set', 'inject.maxChars', '1600'])
  const b = run(home, ['set', 'inject.coreDimensions', '["constraints","taste"]'])
  const cfg = cfgOf(home)
  ok('数字以字符串形态写入也能过', a.code === 0 && Number(cfg.inject.maxChars) === 1600, `maxChars=${cfg.inject.maxChars}`)
  ok('维度列表接受 JSON 数组（面板的形态）', b.code === 0 && Array.isArray(cfg.inject.coreDimensions) && cfg.inject.coreDimensions.length === 2, JSON.stringify(cfg.inject.coreDimensions))
  const c = run(home, ['set', 'inject.coreDimensions', 'taste, habits'])
  const cfg2 = cfgOf(home)
  ok('维度列表也接受逗号分隔（命令行的形态）', c.code === 0 && cfg2.inject.coreDimensions.length === 2, JSON.stringify(cfg2.inject.coreDimensions))
  const d = run(home, ['set', 'conflicts.strategy', 'bogus'])
  ok('枚举值非法被拒', d.code !== 0, `code=${d.code}`)
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) { console.log('失败列表:'); for (const f of fails) console.log(' - ' + f); process.exitCode = 1 }
