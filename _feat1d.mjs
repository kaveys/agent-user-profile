import { readFileSync, writeFileSync } from 'node:fs'

const file = 'bin/profile.mjs'
let t = readFileSync(file, 'utf8')
const before = t

// profile.json 的字段是 builtAt（不是 generatedAt）。取不到日期时退回文件 mtime，
// 而不是让新鲜度算成 NaN 悄悄记 0 分。
t = t.replace(
  "  const ageDays = profile?.generatedAt ? (Date.now() - Date.parse(profile.generatedAt)) / 86400000 : 999",
  "  const stampSource = profile?.builtAt ?? profile?.generatedAt\n  let stamp = stampSource ? Date.parse(stampSource) : NaN\n  if (!Number.isFinite(stamp)) {\n    try { stamp = statSync(p('profile.json')).mtimeMs } catch { stamp = NaN }\n  }\n  const ageDays = Number.isFinite(stamp) ? (Date.now() - stamp) / 86400000 : 999",
)

if (t === before) {
  console.error('no change')
  process.exit(1)
}
writeFileSync(file, t)
console.log('freshness fixed')
