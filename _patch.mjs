import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'bin/profile.mjs'
let s = readFileSync(FILE, 'utf8')
const missed = []
const cut = (from, to, replacement, label) => {
  const a = s.indexOf(from)
  if (a < 0) { missed.push(label + ' (start)'); return }
  const b = s.indexOf(to, a)
  if (b < 0) { missed.push(label + ' (end)'); return }
  s = s.slice(0, a) + replacement + s.slice(b)
}

// ---------------------------------------------------------------- 1) dims remove / move
cut(
  "  if (action === 'remove') {",
  "  if (action === 'reclassify') {",
  `  if (action === 'move') {
    // 大类合并：把 from 下的所有条目搬到 to，条目本身不删（删维度不该连带丢数据）
    if (id === undefined || label === undefined) die('用法：dims move <from> <to>')
    const to = label
    if (!config.dimensions.includes(id)) die(\`没有这个大类：\${id}\`)
    if (!config.dimensions.includes(to)) die(\`没有这个大类：\${to}\`)
    if (id === to) die('from 与 to 相同，没有可移动的条目')
    const records = readJsonl(p('declarations.jsonl'))
    let moved = 0
    const at = nowIso()
    const next = records.map((record) => {
      if (record?.dim !== id) return record
      moved += 1
      return { ...record, dim: to, previousDim: id, at, editedAt: at }
    })
    if (moved === 0) {
      process.stdout.write(\`大类 \${id} 下没有条目，无需移动\\n\`)
      return
    }
    try { snapshotDeclarations('dims-move') } catch { /* 快照失败不阻塞主流程 */ }
    writeJsonl(p('declarations.jsonl'), next)
    appendJsonl(p('changelog.jsonl'), { at, kind: 'dims-move', from: id, to, moved })
    rebuildQuietly()
    process.stdout.write(\`已把 \${moved} 条从 \${id} 移到 \${to}（画像已刷新）\\n\`)
    return
  }
  if (action === 'remove') {
    if (id === undefined) die('用法：dims remove <id>')
    if (BUILTIN_DIMENSION_IDS.includes(id)) {
      die(\`\${id} 是内置大类，不能删除（要给自己的分类腾位置，用 dims add 增加自定义大类）\`)
    }
    if (!config.dimensions.includes(id)) die(\`没有这个大类：\${id}\`)
    const owned = readJsonl(p('declarations.jsonl')).filter((record) => record?.dim === id)
    if (owned.length > 0) {
      die(\`大类 \${id} 下还有 \${owned.length} 条条目，先迁移或删除：\\n  profile dims move \${id} <目标大类>\\n  profile forget --dim \${id}\`)
    }
    config.dimensions = config.dimensions.filter((dim) => dim !== id)
    if (config.dimensionLabels !== undefined) delete config.dimensionLabels[id]
    saveConfig(config)
    rebuildQuietly()
    process.stdout.write(\`已移除大类 \${id}\\n\`)
    return
  }
`,
  'dims remove/move',
)

// ---------------------------------------------------------------- 2) set 的白名单与校验
cut(
  'function cmdSet({ positional }) {',
  'function cmdReset({ flags }) {',
  `// 允许从命令行/面板写入的配置项；不在表里的一律拒绝（否则拼错的键会悄悄写进 config）
const SET_SPEC = {
  enabled: { type: 'boolean', note: '默认叠加总开关' },
  'inject.mode': { type: 'enum', values: ['always', 'on-request'], note: 'always=每次任务都叠加；on-request=只在被要求时' },
  'inject.maxChars': { type: 'number', min: 200, max: 8000, integer: true, note: '注入正文预算（字符）' },
  'inject.topK': { type: 'number', min: 1, max: 50, integer: true, note: '非核心条目最多带几条' },
  'inject.coreDimensions': { type: 'dimensionList', note: '这些大类的条目必进注入块' },
  'inject.personalizeDimensions': { type: 'dimensionList', note: '个性化需求时的主要依据' },
  'inject.priorityOnPersonalize': { type: 'boolean', note: '个性化轮是否以画像为主要依据' },
  'inject.announceSuppressed': { type: 'boolean', note: '喊停时是否在结果里声明' },
  'inject.distillHint': { type: 'boolean', note: '注入块尾部是否附轮末候选提示' },
  'conflicts.strategy': { type: 'enum', values: ['newest', 'freeze'], note: 'newest=新值覆盖；freeze=谁都不选边' },
  'build.minEvidenceForPortrait': { type: 'number', min: 1, max: 50, integer: true, note: '够几条证据才生成可用画像' },
  'build.observedTtlDays': { type: 'number', min: 1, max: 3650, integer: true, note: '行为信号保质期（天）' },
  'build.declaredWeight': { type: 'number', min: 0, max: 1, note: '声明型条目的基础权重' },
  'build.observedWeight': { type: 'number', min: 0, max: 1, note: '观察型条目的基础权重' },
  'build.autoBuild': { type: 'boolean', note: '改完数据是否自动重建画像' },
  'build.autoBuildMinIntervalMs': { type: 'number', min: 0, max: 86400000, integer: true, note: '两次自动重建的最小间隔' },
  'build.dedupe': { type: 'boolean', note: '是否做近似去重' },
  'build.similarityThreshold': { type: 'number', min: 0.1, max: 1, note: '判定同义的相似度阈值' },
  'build.includeObservedItems': { type: 'boolean', note: '是否把运行统计当条目（默认关）' },
  'extract.enabled': { type: 'boolean', note: '轮末是否用模型提炼' },
  'extract.provider': { type: 'string', note: '提炼用的 provider（空=跟随会话）' },
  'extract.model': { type: 'string', note: '提炼用的模型（空=跟随会话）' },
  'extract.everyTurns': { type: 'number', min: 1, max: 50, integer: true, note: '每几轮提炼一次' },
  'extract.minInputChars': { type: 'number', min: 0, max: 100000, integer: true, note: '输入太短就跳过' },
  'extract.maxInputChars': { type: 'number', min: 200, max: 200000, integer: true, note: '输入截断长度' },
  'extract.maxFactsPerTurn': { type: 'number', min: 1, max: 20, integer: true, note: '单轮最多记几条' },
  'extract.autoAcceptConfidence': { type: 'number', min: 0, max: 1, note: '置信度达到多少直接入画像' },
  'extract.requireGlobal': { type: 'boolean', note: '只记可能对全局有用的' },
  'extract.timeoutMs': { type: 'number', min: 3000, max: 300000, integer: true, note: '提炼超时' },
  'extract.maxOutputTokens': { type: 'number', min: 100, max: 8000, integer: true, note: '提炼输出上限' },
  'extract.debugLog': { type: 'boolean', note: '是否打印提炼调试日志' },
  'capture.turnSignals': { type: 'boolean', note: '是否记轮次/步数等结构信号' },
  'capture.toolNames': { type: 'boolean', note: '是否记工具名' },
  'capture.userText': { type: 'boolean', note: '是否把对话正文落盘（永远不建议开）' },
  'capture.turnText': { type: 'boolean', note: '是否允许模型读取轮内正文（只在内存里）' },
  'redaction.mode': { type: 'enum', values: ['unknown', 'off', 'patterns'], note: '脱敏模式' },
  'scope.id': { type: 'string', note: '项目作用域标识（空=用当前目录名）' },
}

function coerceSetting(dotted, rawValue, config) {
  const spec = SET_SPEC[dotted]
  if (spec === undefined) {
    die(\`未知配置项：\${dotted}（用 profile set --list 看可用项）\`)
  }
  if (spec.type === 'boolean') {
    const v = String(rawValue).trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(v)) return true
    if (['false', '0', 'no', 'off'].includes(v)) return false
    die(\`\${dotted} 只接受 true / false（收到 \${JSON.stringify(rawValue)}）\`)
  }
  if (spec.type === 'enum') {
    const v = String(rawValue).trim()
    if (!spec.values.includes(v)) die(\`\${dotted} 只能是 \${spec.values.join(' / ')}（收到 \${JSON.stringify(v)}）\`)
    return v
  }
  if (spec.type === 'number') {
    const n = Number(String(rawValue).trim())
    if (!Number.isFinite(n)) die(\`\${dotted} 需要数字（收到 \${JSON.stringify(rawValue)}）\`)
    if (spec.integer && !Number.isInteger(n)) die(\`\${dotted} 需要整数（收到 \${n}）\`)
    if (n < spec.min || n > spec.max) die(\`\${dotted} 应在 \${spec.min}..\${spec.max} 之间（收到 \${n}）\`)
    return n
  }
  if (spec.type === 'dimensionList') {
    const list = String(rawValue).split(/[,\\s]+/).filter(Boolean)
    if (list.length === 0) return []
    const unknown = list.filter((dim) => !config.dimensions.includes(dim))
    if (unknown.length > 0) die(\`\${dotted} 里有不存在的大类：\${unknown.join(', ')}\`)
    return list
  }
  if (spec.type === 'string') return String(rawValue)
  die(\`配置项 \${dotted} 的类型未定义，先在 SET_SPEC 里补上\`)
}

function cmdSet({ positional, flags }) {
  const [dotted, rawValue] = positional
  if (dotted === undefined || dotted === 'list' || dotted === '--list') {
    process.stdout.write('可写配置项（profile set <键> <值>）：\\n\\n')
    for (const [key, spec] of Object.entries(SET_SPEC)) {
      const range = spec.type === 'number'
        ? \` \${spec.min}..\${spec.max}\`
        : spec.type === 'enum' ? \` \${spec.values.join('|')}\` : ''
      process.stdout.write(\`  \${key.padEnd(34)} \${spec.type}\${range}\\n      \${spec.note ?? ''}\\n\`)
    }
    return
  }
  if (rawValue === undefined) die('用法：set <dotted.key> <value>　（profile set list 看可用项）')
  const config = loadConfig()
  const value = coerceSetting(dotted, rawValue, config)
  const path = dotted.split('.')
  let node = config
  for (const step of path.slice(0, -1)) {
    if (typeof node[step] !== 'object' || node[step] === null) node[step] = {}
    node = node[step]
  }
  node[path[path.length - 1]] = value
  saveConfig(config)
  if (flags['no-rebuild'] !== true) rebuildQuietly()
  process.stdout.write(\`已更新 \${dotted} = \${JSON.stringify(value)}\\n\`)
}

`,
  'cmdSet',
)

writeFileSync(FILE, s)
console.log(missed.length ? 'MISSED: ' + missed.join(', ') : 'patched ok')
