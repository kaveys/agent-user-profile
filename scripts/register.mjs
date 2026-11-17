/**
 * 安装/注册 dsh-user-profile（幂等）：
 *   1) 保证 ~/.dsh/cordis.patch.yml 里有 insert 行（先备份）
 *   2) 保证每个 profile 的 node_modules 里能解析到裸包名 `dsh-user-profile`
 *      —— 本机插件是「链接进 profile 的 node_modules」挂载的，只写 patch 不建链接，
 *        加载时会 ERR_MODULE_NOT_FOUND，插件静默不生效（踩过一次）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-user-profile'
const HERE = dirname(dirname(fileURLToPath(import.meta.url))) // 插件包根目录
const DSH = join(homedir(), '.dsh')
// 装到 ~/.dsh/plugins/<pkg> 是规范位置；从工作区副本跑脚本时也要链到规范位置，避免两份代码分叉。
const INSTALLED = join(DSH, 'plugins', PKG)
const TARGET = existsSync(join(INSTALLED, 'package.json')) ? INSTALLED : HERE

// ---------------------------------------------------------------- 0) 同步源码
// 从工作区副本跑本脚本时，先把改动同步到安装位置：否则「改的是工作区、跑的是旧副本」，
// 这类分叉排查起来极费时间（踩过）。
const SYNC = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'DESIGN.md',
  '.gitignore',
  'LICENSE',
  'docs/POSITIONING.md',
  '_audit.mjs',
  '_audit2.mjs',
  '_audit3.mjs',
  '_audit4.mjs', '_audit5.mjs', '_audit6.mjs', 'docs/CHANGES-v20.md', 'docs/CHANGES-v21.md', 'docs/CHANGES-v22.md', 'scripts/build-video-advantages.ps1',
  '_compat.mjs',
  'docs/COMPATIBILITY.md',
  'docs/CHANGES-v19.md',
  '_e2e.mjs', 'scripts/build-video.ps1',
  '_render.mjs',
  'README.en.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/CHANGES-v14.md',
  'docs/CHANGES-v15.md', 'docs/CHANGES-v16.md', 'docs/CHANGES-v17.md', 'docs/CHANGES-v18.md',
  'mcp/server.mjs',
  'docs/CHANGES-v13.md',
  'docs/CHANGES-v3.md',
  'docs/CHANGES-v3.1.md',
  'docs/CHANGES-v4.md', 'docs/CHANGES-v5.md', 'docs/CHANGES-v5.1.md', 'docs/CHANGES-v6.md', 'docs/CHANGES-v7.md', 'docs/CHANGES-v8.md', 'docs/CHANGES-v9.md', 'docs/CHANGES-v10.md', 'docs/CHANGES-v11.md', 'docs/CHANGES-v12.md',
  'bin/profile.mjs',
  'scripts/register.mjs',
  'scripts/verify-install.mjs',
  '_selftest.mjs', '_e2e.mjs', 'scripts/build-video.ps1', '_render.mjs',
]
if (INSTALLED !== HERE && existsSync(join(INSTALLED, 'package.json'))) {
  let copied = 0
  for (const rel of SYNC) {
    const from = join(HERE, rel)
    if (!existsSync(from)) continue
    const to = join(INSTALLED, rel)
    mkdirSync(dirname(to), { recursive: true })
    const before = existsSync(to) ? readFileSync(to) : null
    const after = readFileSync(from)
    if (before !== null && before.equals(after)) continue
    writeFileSync(to, after)
    copied += 1
  }
  console.log(copied === 0 ? '[0/2] 安装副本已是最新' : `[0/2] 已同步 ${copied} 个文件到 ${INSTALLED}`)
}

// ---------------------------------------------------------------- 1) patch 注册
const file = join(DSH, 'cordis.patch.yml')
const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
if (current.includes(`name: '${PKG}'`)) {
  console.log('[1/2] cordis.patch.yml 已注册，跳过')
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (current.length > 0) writeFileSync(`${file}.bak-userprofile-${stamp}`, current, 'utf8')
  const block = [
    '',
    '# 用户画像插件：采集用户数据 → 生成/更新画像 → 后续任务默认叠加（用户喊停则跳过）。',
    '# 数据目录 %USERPROFILE%/.dsh/user-profile；CLI 在 ~/.dsh/plugins/dsh-user-profile/bin/profile.mjs。',
    '- insert:',
    '    - id: user-profile',
    `      name: '${PKG}'`,
    '',
  ].join('\n')
  writeFileSync(file, `${current.replace(/\s*$/, '')}\n${block}`, 'utf8')
  console.log('[1/2] 已注册；备份：', `${file}.bak-userprofile-${stamp}`)
}

// ---------------------------------------------------------------- 2) profile 链接
const profilesDir = join(DSH, 'profiles')
const profiles = existsSync(profilesDir) ? readdirSync(profilesDir).filter((n) => {
  const p = join(profilesDir, n)
  return statSync(p).isDirectory() && existsSync(join(p, 'package.json'))
}) : []

if (profiles.length === 0) console.log('[2/2] 没找到 profile 目录，跳过链接（DSH 首次启动后再跑一次本脚本）')

for (const name of profiles) {
  const modules = join(profilesDir, name, 'node_modules')
  const link = join(modules, PKG)
  mkdirSync(modules, { recursive: true })
  if (existsSync(link)) {
    // 只比较「能否解析到同一份 package.json」，不主动删除已存在的链接：
    // junction/符号链接在 Windows 上 rmSync 报 EISDIR，递归删又会误删目标目录，风险不值得。
    let same = false
    try { same = realpathSync(link) === realpathSync(TARGET) } catch { same = false }
    const resolvable = existsSync(join(link, 'package.json'))
    if (same) {
      console.log(`[2/2] ${name}: 已存在 → ${TARGET}`)
    } else {
      console.log(`[2/2] ${name}: 已存在但指向别处（${resolvable ? '仍可解析' : '已失效'}），手动处理：`)
      console.log(process.platform === 'win32'
        ? `  cmd /c rmdir "${link}" & cmd /c mklink /J "${link}" "${TARGET}"`
        : `  rm "${link}" && ln -s "${TARGET}" "${link}"`)
    }
    continue
  }
  try {
    // Windows 用 junction（不需要管理员/开发者模式），其它平台用目录符号链接
    symlinkSync(TARGET, link, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`[2/2] ${name}: 已链接 ${link} → ${TARGET}`)
  } catch (error) {
    console.log(`[2/2] ${name}: 链接失败（${error?.code ?? error?.message}）。手动执行：`)
    console.log(process.platform === 'win32'
      ? `  cmd /c mklink /J "${link}" "${TARGET}"`
      : `  ln -s "${TARGET}" "${link}"`)
  }
}

