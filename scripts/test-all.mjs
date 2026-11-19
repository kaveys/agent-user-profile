#!/usr/bin/env node
// 一键跑完整自检：语法 → 14 轮对抗排查 → 单元 → 渲染 → 兼容 → 端到端 → 安装体检。
//
// 为什么要有这个文件：CI 里的步骤清单和本机手敲的命令迟早会不一致，
// 到时候「我本机全过」和「CI 红了」就成了两件事。这里只认一个入口。
//
// 用法：
//   node scripts/test-all.mjs            全部跑
//   node scripts/test-all.mjs --quick    只跑语法 + selftest + audit-10（改小东西时用）
//   node scripts/test-all.mjs --list     只列会跑哪些步骤

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const QUICK = args.has('--quick')
const LIST = args.has('--list')

const SYNTAX = [
  'index.js',
  'client.js',
  'bin/profile.mjs',
  'lib/text.mjs',
  'lib/relevance.mjs',
  'mcp/server.mjs',
  'scripts/register.mjs',
  'scripts/verify-install.mjs',
  'scripts/test-all.mjs',
]

// 自动发现 audit-N.mjs：以后加第 15 轮不用回来改这里（写死清单是漏跑的源头）。
const audits = readdirSync(join(HERE, 'tests'))
  .map((name) => /^audit-(\d+)\.mjs$/.exec(name))
  .filter(Boolean)
  .sort((a, b) => Number(a[1]) - Number(b[1]))
  .map((match) => `tests/audit-${match[1]}.mjs`)

const steps = []
const add = (name, file, extra = []) => steps.push({ name, file, extra })

if (QUICK) {
  add('selftest', 'tests/selftest.mjs')
  add('audit-10（决定论与幂等）', 'tests/audit-10.mjs')
} else {
  for (const file of audits) {
    const label = file.replace('tests/', '').replace('.mjs', '')
    add(label, file)
  }
  add('selftest', 'tests/selftest.mjs')
  add('render（面板渲染烟测）', 'tests/render.mjs')
  add('compat（降级矩阵）', 'tests/compat.mjs')
  add('e2e --cli-only', 'tests/e2e.mjs', ['--cli-only'])
  add('verify-install（安装契约）', 'scripts/verify-install.mjs')
}

if (LIST) {
  console.log(QUICK ? '--quick 会跑：' : '全部会跑：')
  for (const item of SYNTAX) console.log(`  node --check ${item}`)
  for (const step of steps) console.log(`  node ${step.file} ${step.extra.join(' ')}`.trimEnd())
  process.exit(0)
}

const run = (file, extra) => {
  const result = spawnSync(process.execPath, [file, ...extra], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { ok: result.status === 0, status: result.status, out }
}

const failures = []
let passed = 0

console.log('\n一、语法检查')
for (const file of SYNTAX) {
  const result = run('--check', [file])
  if (result.ok) {
    passed += 1
    console.log(`  ok   ${file}`)
  } else {
    failures.push(`--check ${file}\n${result.out.trim().split('\n').slice(0, 6).join('\n')}`)
    console.log(`  FAIL ${file}`)
  }
}

console.log(`\n二、${QUICK ? '快速' : '完整'}测试（${steps.length} 步）`)
for (const step of steps) {
  const started = Date.now()
  const result = run(step.file, step.extra)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  // 测试自己会打一行总结，这里只取最后一行有用信息
  const tail = result.out.trim().split('\n').filter((line) => line.trim().length > 0).pop() ?? ''
  if (result.ok) {
    passed += 1
    console.log(`  ok   ${step.name}  (${seconds}s)  ${tail.slice(0, 80)}`)
  } else {
    failures.push(`${step.file}（exit=${result.status}）\n${result.out.trim().split('\n').slice(-8).join('\n')}`)
    console.log(`  FAIL ${step.name}  (${seconds}s)  ${tail.slice(0, 80)}`)
  }
}

console.log(`\n通过 ${passed} 步，失败 ${failures.length} 步`)
if (failures.length > 0) {
  console.log('\n失败详情：')
  for (const failure of failures) console.log(`\n--- ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
