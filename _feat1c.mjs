import { readFileSync, writeFileSync } from 'node:fs'

const file = 'bin/profile.mjs'
let t = readFileSync(file, 'utf8')
const before = t

// healthOf 用的是扁平条目列表，profile.json 里是分维度的 sections —— 必须走 flatten。
t = t.replace(
  "  const items = profile?.items ?? []\n  const declared = declarations.length",
  "  const items = profile === undefined || profile === null ? [] : flatten(profile, config)\n  const declared = declarations.length",
)

// explain 里的「核心」只该标真正标了 core 的；红线维度单独用「红线」标，别把两类混成一颗徽章。
t = t.replace(
  "      core: Boolean(record.core) || config.inject.coreDimensions.includes(record.dim),",
  "      core: record.core === true,\n      redline: config.inject.coreDimensions.includes(record.dim),",
)
t = t.replace(
  "    lines.push('- [' + item.dimLabel + ' ' + item.weight.toFixed(2) + (item.core ? '·核心' : '') + '] 相关度 ' + (item.score * 100).toFixed(0) + '% :: ' + item.text)",
  "    const mark = item.core ? '·核心' : item.redline ? '·红线' : ''\n    lines.push('- [' + item.dimLabel + ' ' + item.weight.toFixed(2) + mark + '] 相关度 ' + (item.score * 100).toFixed(0) + '% :: ' + item.text)",
)
t = t.replace(
  "  const carried = scored.filter((item) => item.core || item.score >= threshold)\n  const dropped = scored.filter((item) => !(item.core || item.score >= threshold))",
  "  const carried = scored.filter((item) => item.core || item.redline || item.score >= threshold)\n  const dropped = scored.filter((item) => !(item.core || item.redline || item.score >= threshold))",
)

if (t === before) {
  console.error('no change')
  process.exit(1)
}
writeFileSync(file, t)
console.log('health/explain fixed')
