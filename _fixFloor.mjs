import { readFileSync, writeFileSync } from 'node:fs'

// 真缺陷：explain 用的 inject.relevanceFloor 既不能在面板看到、也不能用 set 调
// —— 和 v20 修掉的 patternCount 是同一类漂移，方向相反（能用的参数藏起来了）。
let bin = readFileSync('bin/profile.mjs', 'utf8')
const binBefore = bin

bin = bin.replace(
  "  'inject.relevantOnly': { type: 'boolean', note: '只带入和本轮相关的条目（红线永远带入）' },",
  "  'inject.relevantOnly': { type: 'boolean', note: '只带入和本轮相关的条目（红线永远带入）' },\n  'inject.relevanceFloor': { type: 'number', min: 0, max: 1, note: '相关性门槛：低于这个比例算与本轮无关（默认 0.12）' },",
)

bin = bin.replace(
  "      relevantOnly: config.inject.relevantOnly !== false,",
  "      relevantOnly: config.inject.relevantOnly !== false,\n      relevanceFloor: Number(config.inject?.relevanceFloor ?? 0.12),",
)

// 默认配置里补上，免得「字段存在但没默认值」再骗一次
bin = bin.replace(
  "    relevantOnly: true,",
  "    relevantOnly: true,\n    relevanceFloor: 0.12,",
)

if (bin === binBefore) {
  console.error('bin/profile.mjs: no change')
  process.exit(1)
}
writeFileSync('bin/profile.mjs', bin)

let client = readFileSync('client.js', 'utf8')
const clientBefore = client
client = client.replace(
  "        { path: 'inject.relevantOnly', label: '只带入和本轮相关的条目', type: 'bool', hint: '关掉则每次把整份画像都带进来（红线永远带入）' },",
  "        { path: 'inject.relevantOnly', label: '只带入和本轮相关的条目', type: 'bool', hint: '关掉则每次把整份画像都带进来（红线永远带入）' },\n        { path: 'inject.relevanceFloor', label: '相关性门槛', type: 'number', hint: '0–1，默认 0.12：低于这个比例算与本轮无关；红线与核心条目不受影响' },",
)
if (client === clientBefore) {
  console.error('client.js: no change')
  process.exit(1)
}
writeFileSync('client.js', client)
console.log('relevanceFloor exposed in set + panel + settings UI')
