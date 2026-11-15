/**
 * 安装体检：不启动 dsh，把「插件能不能被加载」逐条核实。
 *
 * 检查项对应真实加载路径（每条都来自 DSH 源码，不是猜的）：
 *   1. patch 行存在                  ← ~/.dsh/cordis.patch.yml
 *   2. 裸包名可解析                  ← profile 的 node_modules（junction/符号链接）
 *   3. dsh.bundle.patch 指向的文件在   ← loader 读 dsh.bundle.patch
 *   4. dsh.client.platform === 'web'  ← dsh-client-modules 只认真实字符串
 *   5. exports['./client'] 是字符串   ← clientExportOf() 要求
 *   6. client.js 存在且是 __ModuleLoader__.load 形状
 *   7. index.js 语法 + 导出 name/apply（ESM 动态 import 验证）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = 'dsh-user-profile'
const DSH = join(homedir(), '.dsh')
const INSTALLED = join(DSH, 'plugins', PKG)
const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass, detail })

// 1 patch 行
const patch = existsSync(join(DSH, 'cordis.patch.yml')) ? readFileSync(join(DSH, 'cordis.patch.yml'), 'utf8') : ''
ok('cordis.patch.yml 有 insert 行', new RegExp(`name:\\s*['"]${PKG}['"]`).test(patch))

// 2 裸包名可解析（模拟 loader：从一个 profile 目录解析）
const profilesDir = join(DSH, 'profiles')
const profileRoot = existsSync(profilesDir)
  ? join(profilesDir, 'desktop', 'package.json')
  : join(DSH, 'package.json')
let resolved = ''
try {
  resolved = createRequire(profileRoot).resolve(PKG)
} catch { resolved = '' }
ok('裸包名可解析（profile node_modules 链接）', resolved.length > 0, resolved || 'ERR_MODULE_NOT_FOUND')

// 3-6 package.json 与 client bundle
const pkgPath = join(INSTALLED, 'package.json')
ok('安装目录存在', existsSync(pkgPath), INSTALLED)
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {}
ok('dsh.bundle.patch 文件存在', existsSync(join(INSTALLED, pkg?.dsh?.bundle?.patch ?? 'cordis.patch.yml')))
ok('dsh.client.platform === "web"', pkg?.dsh?.client?.platform === 'web', String(pkg?.dsh?.client?.platform))
const clientRel = pkg?.exports?.['./client']
ok("exports['./client'] 是字符串", typeof clientRel === 'string', typeof clientRel)
const clientFile = typeof clientRel === 'string' ? join(INSTALLED, clientRel) : ''
ok('client.js 存在', clientFile.length > 0 && existsSync(clientFile), clientFile)
if (clientFile.length > 0 && existsSync(clientFile)) {
  const src = readFileSync(clientFile, 'utf8')
  ok('client bundle 形状（__ModuleLoader__.load + factory）', /__ModuleLoader__\.load\s*\(/.test(src) && /factory\s*\(/.test(src))
  ok('client bundle 未 require 宿主客户端包', !/require\(\s*['"]@deepseek-ai\//.test(src))
  ok('client bundle 着色只用主题变量', !/#[0-9a-fA-F]{3,6}\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
}

// 7 宿主插件导出
const entry = join(INSTALLED, 'index.js')
try {
  const mod = await import(pathToFileURL(entry).href)
  const p = mod.default ?? mod
  ok('index.js 可 import 且导出 name/apply', p?.name === PKG && typeof p?.apply === 'function', `${p?.name} / ${typeof p?.apply}`)
} catch (error) {
  ok('index.js 可 import 且导出 name/apply', false, error?.message)
}

// 8 数据目录
ok('数据目录已初始化', existsSync(join(DSH, 'user-profile', 'config.json')), join(DSH, 'user-profile'))

const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
}
const failed = results.filter((r) => !r.pass).length
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`)
process.exitCode = failed === 0 ? 0 : 1
