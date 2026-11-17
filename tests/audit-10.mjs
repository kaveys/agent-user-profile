/**
 * 第十轮排查 —— 换一个角度：不看「功能对不对」，看「重构有没有偷偷改语义」和「仓库自己说不说得通」。
 *
 * 为什么需要这一轮：v26 把相似度与相关性判定抽进了 lib/，v27 又把测试搬进 tests/、文档搬进 docs/changelog/。
 * 这类搬家不会让任何一条业务用例变红，却能让 CI、安装同步、文档链接全部指向不存在的文件。
 * 所以这里只查三件事：
 *   A. 判定数学与重构前一致（含对称性、数字守卫、包含关系、决定论）
 *   B. 仓库里每一处「引用的路径」都真实存在（package.json / register SYNC / CI / README）
 *   C. 同一条命令跑两遍，结果一致（幂等，不靠运气）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(HERE, 'bin', 'profile.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'dsh-profile-a10-'))
const env = { ...process.env, DSH_USER_PROFILE_HOME: HOME, DSH_PROFILE_DIAG: '0' }

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const cli = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: HERE })
const json = (args, fallback = null) => {
  try { return JSON.parse(cli(args)) } catch { return fallback }
}

// ---------------------------------------------------------------- A. 判定数学的等价性
const { mergeScore, similarity, coverage, normText } = await import(`file://${join(HERE, 'lib', 'text.mjs').replace(/\\/g, '/')}`)

const paraphrase = ['用户要求界面简洁，不要花哨动画', '界面要简洁，别整那些花哨的动画效果']
const separation = ['用户要求不同插件职责分离，功能不要混在一起', '不同插件职责分离，功能不要混在一起']
const unrelated = ['用户喜欢冷色调', '用户在做 APK 逆向']

check('同义改写仍被判为同义（重构没改阈值）', mergeScore(...paraphrase) >= 0.35, `score=${mergeScore(...paraphrase).toFixed(2)}`)
check('插值过的主语不影响判定', mergeScore(...separation) >= 0.5, `score=${mergeScore(...separation).toFixed(2)}`)
check('无关条目仍判为不同', mergeScore(...unrelated) < 0.2, `score=${mergeScore(...unrelated).toFixed(2)}`)
check('数字不同永不判同义（班级/条数/版本）', mergeScore('用户要求并发写入第 1 条', '用户要求并发写入第 2 条') === 0)
check('一边有数字一边没有也不合并', mergeScore('用户要求记住 1 班', '用户要求记住班级') === 0)
check('一句话被另一句完整包含时覆盖率接近 1', coverage('用户要求界面简洁', '用户要求界面简洁，不要花哨动画') >= 0.9)
check('完全相同得 1 分', similarity('同样的句子', '同样的句子') === 1)
check('标点与空白不影响相似度', similarity('界面要简洁。', '界面要简洁') === 1, normText('界面要简洁。'))
check('分数对称', Math.abs(mergeScore(...paraphrase) - mergeScore(...[...paraphrase].reverse())) < 1e-9)
let stable = true
const first = mergeScore(...paraphrase)
for (let i = 0; i < 500; i += 1) if (Math.abs(mergeScore(...paraphrase) - first) > 1e-12) stable = false
check('同一输入 500 次结果完全一致（决定论）', stable)

// ---------------------------------------------------------------- B. 仓库自洽：引用的路径都得真实存在
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const missingPkgFiles = (pkg.files ?? []).filter((rel) => !existsSync(join(HERE, rel)))
check('package.json 的 files 每一项都存在', missingPkgFiles.length === 0, missingPkgFiles.join(', '))

const registerSrc = readFileSync(join(HERE, 'scripts', 'register.mjs'), 'utf8')
const syncBlock = /const SYNC = \[([\s\S]*?)\n\]/.exec(registerSrc)?.[1] ?? ''
const syncPaths = [...syncBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
const missingSync = syncPaths.filter((rel) => !existsSync(join(HERE, rel)))
check('register.mjs 的 SYNC 每一项都存在（否则安装副本静默缺文件）', syncPaths.length > 0 && missingSync.length === 0, `共 ${syncPaths.length} 条，缺 ${missingSync.join(', ') || '无'}`)

const ciSrc = readFileSync(join(HERE, '.github', 'workflows', 'ci.yml'), 'utf8')
const ciPaths = [...ciSrc.matchAll(/node (?:--check )?([A-Za-z0-9._/-]+\.mjs)/g)].map((m) => m[1])
const missingCi = [...new Set(ciPaths)].filter((rel) => !existsSync(join(HERE, rel)))
check('CI 里 --check / run 的每个脚本都存在', ciPaths.length >= 10 && missingCi.length === 0, `共 ${new Set(ciPaths).size} 个，缺 ${missingCi.join(', ') || '无'}`)

const readme = readFileSync(join(HERE, 'README.md'), 'utf8')
const docRefs = [...readme.matchAll(/\b((?:tests|scripts|docs|lib|bin|mcp)\/[A-Za-z0-9._/-]+\.(?:mjs|md|yml|ps1|py|png|mp4|srt|txt))/g)].map((m) => m[1])
// 通配写法（docs/changelog/CHANGES-*.md、tests/audit-1…9.mjs）按目录存在性判断
const docMissing = [...new Set(docRefs)].filter((rel) => {
  if (rel.includes('*')) return false
  if (rel.includes('…')) return false
  if (rel.endsWith('/')) return !existsSync(join(HERE, rel))
  return !existsSync(join(HERE, rel))
})
check('README 引用的脚本/文档/图片都存在', docMissing.length === 0, docMissing.join(', ') || `${new Set(docRefs).size} 处引用`)

const changelogRefs = [...readme.matchAll(/docs\/changelog\/CHANGES-[\w.-]+\.md/g)].map((m) => m[0])
check('README 指向的变更记录确实在 docs/changelog/', changelogRefs.every((rel) => existsSync(join(HERE, rel))), `${changelogRefs.length} 处`)

const junk = ['node_modules/', 'scripts/video-build/', 'scripts/trailer-build/']
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: HERE }).split('\n').filter(Boolean)
const trackedJunk = tracked.filter((rel) => junk.some((prefix) => rel.startsWith(prefix)))
check('仓库没有把构建/渲染中间产物纳入版本管理', trackedJunk.length === 0, trackedJunk.slice(0, 3).join(', '))

// ---------------------------------------------------------------- C. 幂等：跑两遍结果一致
cli(['init'])
cli(['declare', '--dim', 'taste', '--fact', '用户偏爱克制的深色界面', '--confidence', '0.9', '--force'])
cli(['declare', '--dim', 'constraints', '--fact', '用户要求上传前必须彻底脱敏', '--confidence', '0.9', '--force'])
cli(['build'])

const inject1 = readFileSync(join(HOME, 'inject.md'), 'utf8')
cli(['build'])
const inject2 = readFileSync(join(HOME, 'inject.md'), 'utf8')
const stripStamp = (text) => text
  .replace(/^# 用户画像 v\d+$/m, '# 用户画像 v<n>')
  .replace(/生成于 [^\n]+/g, '生成于 <时间>')
check('连续 build 两次，注入正文完全一致（只有版本号与时间戳会变）', stripStamp(inject1) === stripStamp(inject2))

const order1 = (json(['panel'])?.items ?? []).map((item) => item.id)
const order2 = (json(['panel'])?.items ?? []).map((item) => item.id)
check('panel 条目顺序稳定（同输入两次一致）', order1.length > 0 && order1.join(',') === order2.join(','))

const explainArgs = ['explain', '界面 风格', '--json']
check('explain 同输入两次结论一致', JSON.stringify(json(explainArgs)) === JSON.stringify(json(explainArgs)))

cli(['declare', '--dim', 'taste', '--fact', '用户要求界面简洁，不要花哨动画', '--confidence', '0.8', '--force', '--no-merge'])
cli(['declare', '--dim', 'taste', '--fact', '界面要简洁，别整那些花哨的动画效果', '--confidence', '0.9', '--force', '--no-merge'])
const before = (json(['panel'])?.items ?? []).length
cli(['dedupe', '--apply'])
const afterFirst = (json(['panel'])?.items ?? []).length
cli(['dedupe', '--apply'])
const afterSecond = (json(['panel'])?.items ?? []).length
check('dedupe 合并后条目数下降', afterFirst < before, `${before} → ${afterFirst}`)
check('dedupe 再跑一次是 no-op（幂等）', afterSecond === afterFirst, `${afterFirst} → ${afterSecond}`)

console.log('')
if (failures.length === 0) console.log(`第十轮排查：全部通过（${passed} 项）`)
else { console.log(`第十轮排查：${failures.length} 项失败（通过 ${passed}）`); for (const f of failures) console.log(` - ${f}`) }
process.exitCode = failures.length === 0 ? 0 : 1
