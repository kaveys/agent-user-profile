#!/usr/bin/env node
/**
 * dsh-profile — dsh-user-profile 的存储层与呈现层。
 *
 * 设计要点：
 *   1) 写入只追加（JSONL），覆盖语义只发生在 build 的聚合阶段；
 *   2) 聚合是确定性的：同样的输入永远得到同样的画像，便于审计；
 *   3) 注入用「两段式」：核心条目（红线/身份）必定进入，其余按权重取前 K 条；
 *   4) 冲突有三种结局：newest（新值胜）/ freeze（两条并留、等用户裁决）/ unresolved；
 *   5) 面板通过 `panel` 子命令取同一份数据的 JSON 视图，页面不重复算权重。
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HOME = process.env.DSH_USER_PROFILE_HOME || join(homedir(), '.dsh', 'user-profile')
const p = (...parts) => join(HOME, ...parts)

/** 维度显示名：自定义维度优先，其次内置表，最后退回 id 本身。 */
const labelOf = (dim, config) => config?.dimensionLabels?.[dim] ?? DIMENSION_LABELS[dim] ?? dim

/**
 * 画像大类（v6）。
 *
 * 划分依据三条：
 *   1) 一类只回答一个问题 —— 他是谁 / 他会什么 / 他何时怎么做事 / 他喜欢什么 /
 *      他要达成什么 / 跟谁 / 什么不能碰 / 要我怎么说；
 *   2) 稳定压过详尽 —— 会随项目变的东西归 goals，不许占用身份位；
 *   3) 最容易混的两对，用一句话切开 ——
 *      work 是「在哪做什么」，skills 是「会什么」；
 *      taste 是「喜欢什么样」，communication 是「要我怎么说」。
 *
 * id 保持英文小写（写进文件、进 key、进配置，改名会丢数据），label 与 hint 给人和模型看。
 */
const DIMENSIONS = [
  {
    id: 'identity',
    label: '身份与背景',
    hint: '称呼、年龄、性别、所在地与时区、母语、学校与专业、家庭角色',
    keys: ['name', 'age', 'city', 'lang', 'school', 'major', 'role'],
  },
  {
    id: 'work',
    label: '学业与职业',
    hint: '在读还是在职、行业与岗位、负责什么、所在团队与项目',
    keys: ['status', 'field', 'title', 'project'],
  },
  {
    id: 'skills',
    label: '能力与工具',
    hint: '熟悉的技术栈、软件与语言、熟练程度、常用工具链',
    keys: ['stack', 'tool', 'lang', 'level'],
  },
  {
    id: 'habits',
    label: '习惯与节奏',
    hint: '作息与专注时段、做事方式、整理与备份习惯、更新与交付节奏',
    keys: ['hours', 'style', 'ritual', 'cadence'],
  },
  {
    id: 'interests',
    label: '兴趣与爱好',
    hint: '游戏、音乐、影视、阅读、运动、收藏、动手创作',
    keys: ['game', 'music', 'film', 'book', 'sport', 'craft'],
  },
  {
    id: 'taste',
    label: '审美与口味',
    hint: '视觉风格、界面口味、内容偏好、品牌与产品喜好',
    keys: ['style', 'visual', 'content', 'brand'],
  },
  {
    id: 'goals',
    label: '目标与计划',
    hint: '正在学什么、短期与长期目标、在推进的项目、时间点',
    keys: ['now', 'long', 'learning', 'deadline'],
  },
  {
    id: 'social',
    label: '关系与协作',
    hint: '和谁一起做事、在团队里的角色、沟通对象、分享与公开习惯',
    keys: ['team', 'peer', 'share'],
  },
  {
    id: 'constraints',
    label: '约束与红线',
    hint: '禁忌与硬性要求、必须遵守的做法、不可触碰的话题或操作',
    keys: ['must', 'never', 'limit'],
  },
  {
    id: 'communication',
    label: '沟通与表达',
    hint: '回答长度与结构、语气、用什么语言、要不要表格/代码/清单',
    keys: ['length', 'tone', 'format', 'lang'],
  },
]

const DIMENSION_LABELS = Object.fromEntries(DIMENSIONS.map((d) => [d.id, d.label]))
const DIMENSION_HINTS = Object.fromEntries(DIMENSIONS.map((d) => [d.id, d.hint]))
const BUILTIN_DIMENSION_IDS = DIMENSIONS.map((d) => d.id)

/** 旧维度（v5 及以前）→ 新大类。只用于迁移，跑过一次就再也用不到。 */
const LEGACY_DIMENSION_MAP = {
  preferences: 'taste',
  workflow: 'habits',
  expertise: 'skills',
  design: 'taste',
  process: 'habits',
  tools: 'skills',
  tooling: 'skills',
  planning: 'goals',
  hobby: 'interests',
  hobbies: 'interests',
  school: 'identity',
  education: 'identity',
}

/**
 * 老数据里的 preferences 是个筐：工具偏好、回答格式、界面审美全塞在里面。
 * 迁移时按内容重新归类，别让新分类只是换了个马甲。
 */
function classifyLegacy(record) {
  const text = `${record?.key ?? ''} ${record?.fact ?? ''}`
  const rules = [
    [/(熟悉|掌握|精通|懂|能手|能主导|技术栈|框架|机制|编辑器|命令行|IDE|VS ?Code|vim|python|node)/i, 'skills'],
    [/(工具|软件|技术|语言)/i, 'skills'],
    [/(回答|回复|格式|表格|清单|长度|语气|措辞|输出|markdown)/i, 'communication'],
    [/(流程|节奏|备份|整理|重做|核对|习惯|时段|作息)/i, 'habits'],
    [/(目标|计划|打算|正在学|deadline|截止)/i, 'goals'],
    [/(游戏|音乐|影视|书|电影|运动|爱好)/i, 'interests'],
    [/(界面|风格|配色|视觉|审美|设计|好看|观感|形态)/i, 'taste'],
  ]
  for (const [pattern, dim] of rules) {
    if (pattern.test(text)) return dim
  }
  const mapped = LEGACY_DIMENSION_MAP[record?.dim]
  return mapped ?? 'taste'
}

const DEFAULT_CONFIG = {
  schemaVersion: 4,
  // 默认叠加开关：true = 每次任务前注入画像
  enabled: true,
  inject: {
    // 'always' 默认叠加；'on-request' = 仅当用户在对话里要求时才注入（关闭默认叠加）
    mode: 'always',
    // 注入正文预算；两段式分配：核心段最多占 70%，其余给按权重排序的 topK
    maxChars: 1600,
    topK: 8,
    // 这几个维度的条目一律视为「核心」：不受 topK 限制，优先进入注入块
    coreDimensions: ['constraints', 'identity'],
    // 个性化需求（风格、口味、默认选择、文案、推荐、界面）以这些维度为主要依据
    personalizeDimensions: ['taste', 'communication', 'habits', 'interests', 'goals'],
    // 是否在注入块里单列「个性化首选」段；关掉则退回「全部按权重排」的老样子
    priorityOnPersonalize: true,
    announceSuppressed: true,
    maxAgeDays: 30,
    // 注入块尾部附一句「轮末可 declare --pending」，把自动蒸馏变成可审核的候选
    distillHint: true,
  },
  capture: {
    turnSignals: true,
    toolNames: true,
    // 对话正文永不自动落盘；需要记录的内容走 declare（可审计、可删除）
    userText: false,
    // 但语义提取需要「读」正文：默认开。正文只在内存里拼成一次模型请求，
    // 落盘的永远只有提炼出的那条结论，不是原文。关掉它 = 只留行为信号。
    turnText: true,
  },
  // 智能提取（由 host 插件在轮末执行，这里只放默认参数）
  extract: {
    enabled: true,
    provider: '',
    model: '',
    everyTurns: 1,
    minInputChars: 60,
    maxInputChars: 6000,
    maxFactsPerTurn: 5,
    autoAcceptConfidence: 0.7,
    timeoutMs: 45000,
    maxOutputTokens: 900,
    debugLog: false,
  },
  // 隐私规则未确认前的保守默认：不做任何正则替换，只靠「不采集正文、只采集结构信号」把风险面压到最小。
  // 一旦（待补充：授权与隐私规则）确定，在这里加 patterns 即可，格式 { name, pattern, flags?, replace? }。
  redaction: { mode: 'unknown', patterns: [] },
  build: {
    observedTtlDays: 90,
    minEvidenceForPortrait: 3,
    declaredWeight: 1,
    observedWeight: 0.4,
    // 每轮结束后自动重建画像：没有它，画像永远停在「从未 build」，
    // 面板和注入都只能是空的（这是 v2 之前最要命的体验问题）。
    autoBuild: true,
    // 自动重建的最小间隔，避免每轮都 spawn 一次 CLI
    autoBuildMinIntervalMs: 60000,
    // 同维度近似去重：模型换着 key 重述同一件事时，靠相似度合并，避免画像越用越肿
    dedupe: true,
    // 0.45 的由来：实测同义改写的两条偏好相似度 0.462，而不相关的两条只有 0.31。
    similarityThreshold: 0.45,
    // 早期版本会把「常用工具占比 / 单轮平均工具调用 / 活跃时段」当成画像条目写进去。
    // 那是 Agent 自己的运行统计，不是用户是谁 —— 界面上看着像画像，读起来全是噪音，
    // 所以默认不再产出；原始记录仍留在 observations/，只供内部判断「证据够不够」。
    includeObservedItems: false,
  },
  conflicts: {
    // 'newest' = 新值覆盖旧值（旧值进 history）；'freeze' = 两条并留，标未决，等用户 review
    strategy: 'newest',
  },
  scope: {
    // 项目作用域标识；留空则取当前工作目录名
    id: '',
  },
  suppressPatterns: [
    '不使用画像', '不要使用画像', '不用画像', '别用画像', '忽略画像', '不要结合画像',
    '不结合画像', '不带画像', '不参考画像', '画像先放一边', '清空画像上下文',
    'no profile', 'without profile', '--no-profile', 'ignore the profile',
  ],
  dimensions: [...BUILTIN_DIMENSION_IDS],
  // 自定义维度标签：`dims add <id> <标签>` 会写在这里，build 用它渲染章节名。
  dimensionLabels: {},
}

// ---------------------------------------------------------------- 基础工具

const nowIso = () => new Date().toISOString()
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const round = (n, digits = 2) => Number(Number(n ?? 0).toFixed(digits))

function die(message) {
  process.stderr.write(`dsh-profile: ${message}\n`)
  process.exit(1)
}

function ensureDirs() {
  mkdirSync(p('observations'), { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写：先写同目录临时文件再 rename，进程被杀也不会留下半截文件。 */
function writeFileAtomic(file, text) {
  ensureDirs()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/**
 * 互斥锁：改写型操作（forget / edit / review / import）必须先拿锁。
 * 只追加（declare / observe）不需要锁——O_APPEND 本身就是原子的；
 * 但「读全量 → 改几条 → 整表写回」一旦并发就会互相覆盖，那才是丢数据的根源。
 */
function withLock(fn, { tries = 200, waitMs = 50 } = {}) {
  ensureDirs()
  const lock = p('.lock')
  const release = () => {
    try {
      unlinkSync(lock)
    } catch {
      // 锁文件已经不在（另一个进程清理过），忽略
    }
  }
  for (let i = 0; i < tries; i += 1) {
    try {
      const fd = openSync(lock, 'wx')
      closeSync(fd)
      writeFileSync(lock, String(Date.now()), 'utf8')
      // die() 走 process.exit，finally 不会执行：用 exit 钩子兜底。
      // 否则一次参数错误就能留下锁，把后面所有改写型命令全卡死。
      process.once('exit', release)
      try {
        return fn()
      } finally {
        process.removeListener('exit', release)
        release()
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 陈旧锁：持有者崩在中间，超过 60s 视为失效
      try {
        const age = Date.now() - Number(readFileSync(lock, 'utf8'))
        if (Number.isFinite(age) && age > 60000) unlinkSync(lock)
      } catch {
        // 读不到就继续等
      }
      const until = Date.now() + waitMs
      while (Date.now() < until) { /* 忙等一小段，避免再起定时器 */ }
    }
  }
  die(`另一个 profile 进程正持有锁（${lock}）；等它结束或删除该文件后重试`)
}

function writeJson(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // 坏行跳过：宁可少一条，也不要整个画像构建失败
    }
  }
  return out
}

function appendJsonl(file, record) {
  ensureDirs()
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

function writeJsonl(file, records) {
  writeFileAtomic(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''))
}

function loadConfig() {
  const file = p('config.json')
  const raw = readJson(file, {})
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    // 展开 raw 会把旧版本号带回来，所以最后显式钉成当前版本
    schemaVersion: DEFAULT_CONFIG.schemaVersion,
    inject: { ...DEFAULT_CONFIG.inject, ...(raw.inject ?? {}) },
    capture: { ...DEFAULT_CONFIG.capture, ...(raw.capture ?? {}) },
    build: { ...DEFAULT_CONFIG.build, ...(raw.build ?? {}) },
    redaction: { ...DEFAULT_CONFIG.redaction, ...(raw.redaction ?? {}) },
    conflicts: { ...DEFAULT_CONFIG.conflicts, ...(raw.conflicts ?? {}) },
    scope: { ...DEFAULT_CONFIG.scope, ...(raw.scope ?? {}) },
    suppressPatterns: Array.isArray(raw.suppressPatterns) && raw.suppressPatterns.length > 0
      ? raw.suppressPatterns
      : DEFAULT_CONFIG.suppressPatterns,
    dimensionLabels: { ...(raw.dimensionLabels ?? {}) },
  }
  const rawVersion = Number(raw?.schemaVersion) || 0
  // v3 换了大类体系：老配置里的 dimensions 是旧六维，必须整表替换，
  // 否则 build 只认得旧维度名，新条目会被静默丢掉。
  if (rawVersion < 3) {
    merged.dimensions = [...BUILTIN_DIMENSION_IDS]
  } else if (Array.isArray(raw.dimensions) && raw.dimensions.length > 0) {
    merged.dimensions = raw.dimensions
  } else {
    merged.dimensions = [...BUILTIN_DIMENSION_IDS]
  }
  migrateConfig(file, raw, merged)
  return merged
}

/** 仅在版本落后时回写一次，并留 .bak-v<n> 备份；失败不影响本次读取。 */
function migrateConfig(file, raw, merged) {
  const version = Number(raw?.schemaVersion) || 0
  if (version >= DEFAULT_CONFIG.schemaVersion) return
  try {
    if (existsSync(file)) {
      copyFileSync(file, `${file}.bak-v${version}-${Date.now()}`)
    }
    ensureDirs()
    writeJson(file, merged)
  } catch {
    // 迁移是加分项，读不到旧配置也不该让命令失败
  }
  if (version < 3) migrateDeclarationDimensions(version)
}

/**
 * v3：维度换了一套大类。老记录不能只换配置、留着旧 dim —— 那会让 build 把它们全丢掉
 * （维度不在 dimensions 里就不渲染）。所以按内容重新归类，并备份原始文件。
 */
function migrateDeclarationDimensions(version) {
  try {
    const file = p('declarations.jsonl')
    if (!existsSync(file)) return
    const records = readJsonl(file)
    let changed = 0
    const next = records.map((record) => {
      // 已经是新大类、也不是旧的别名，就别动
      if (BUILTIN_DIMENSION_IDS.includes(record?.dim) && LEGACY_DIMENSION_MAP[record.dim] === undefined) {
        return record
      }
      const target = classifyLegacy(record)
      if (target === record.dim) return record
      changed += 1
      return { ...record, dim: target, previousDim: record.dim }
    })
    if (changed === 0) return
    copyFileSync(file, `${file}.bak-dimsv${version}-${Date.now()}`)
    writeJsonl(file, next)
    appendJsonl(p('changelog.jsonl'), { at: nowIso(), kind: 'migrate-dimensions', from: version, changed })
  } catch {
    // 迁移失败不清数据：宁可维持老维度，也不丢记录
  }
}

function saveConfig(config) {
  ensureDirs()
  writeJson(p('config.json'), config)
}

/** 按（待补充：隐私规则）预留的脱敏钩子；规则未配置时原样返回。 */
function redact(text, config) {
  if (typeof text !== 'string') return ''
  const patterns = Array.isArray(config?.redaction?.patterns) ? config.redaction.patterns : []
  let out = text
  for (const rule of patterns) {
    if (typeof rule?.pattern !== 'string') continue
    try {
      out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), rule.replace ?? '[已脱敏]')
    } catch {
      // 规则写错不影响采集
    }
  }
  return out
}

// ---------------------------------------------------------------- 作用域与排序

/** 当前生效的作用域：global 条目永远生效，project 条目只在同 id 下生效。 */
function activeScope(flags, config) {
  const id = typeof flags['scope-id'] === 'string' && flags['scope-id'].length > 0
    ? flags['scope-id']
    : (typeof config.scope?.id === 'string' && config.scope.id.length > 0
      ? config.scope.id
      : basename(process.cwd()))
  return { id, includeAll: flags['all-scopes'] === true }
}

function inScope(record, scope) {
  if (scope.includeAll) return true
  const s = record?.scope ?? 'global'
  if (s === 'global') return true
  if (s === 'session') return false
  return (record.scopeId ?? '') === scope.id
}

/** 统一排序：权重降序 → 最近出现降序 → 核心优先。面板与注入都用它，保证两处一致。 */
function rankItem(a, b) {
  const wa = Number(a?.weight ?? 0)
  const wb = Number(b?.weight ?? 0)
  if (wa !== wb) return wb - wa
  const ta = String(a?.lastSeen ?? '')
  const tb = String(b?.lastSeen ?? '')
  if (ta !== tb) return tb.localeCompare(ta)
  return String(b?.text ?? '').length - String(a?.text ?? '').length
}

function isCore(item, config) {
  if (item?.core === true) return true
  const dims = Array.isArray(config?.inject?.coreDimensions) ? config.inject.coreDimensions : []
  return dims.includes(item?.dim)
}

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i += 1
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

// ---------------------------------------------------------------- 子命令

function cmdInit({ flags }) {
  ensureDirs()
  if (existsSync(p('config.json')) && flags.force !== true) {
    process.stdout.write(`config 已存在：${p('config.json')}（加 --force 覆盖为默认值）\n`)
    return
  }
  saveConfig(DEFAULT_CONFIG)
  for (const file of ['declarations.jsonl', 'changelog.jsonl', 'pending.jsonl']) {
    if (!existsSync(p(file))) writeFileSync(p(file), '', 'utf8')
  }
  process.stdout.write(`已初始化：${HOME}\n`)
}

function cmdDeclare({ flags }) {
  const dim = typeof flags.dim === 'string' ? flags.dim : 'taste'
  const fact = typeof flags.fact === 'string' ? flags.fact.trim() : ''
  if (fact.length === 0) die('缺少 --fact "要记录的内容"')
  const config = loadConfig()
  if (!config.dimensions.includes(dim)) {
    die(`未知维度 ${dim}；可用：${config.dimensions.join(', ')}`)
  }
  const source = flags.source === 'model' ? 'model' : 'user'
  const confidence = Number.isFinite(Number(flags.confidence)) ? Number(flags.confidence) : (source === 'user' ? 1 : 0.6)
  const scopeKind = typeof flags.scope === 'string' && flags.scope.length > 0 ? flags.scope : 'global'
  const record = {
    id: newId('dcl'),
    at: nowIso(),
    dim,
    key: typeof flags.key === 'string' && flags.key.length > 0 ? flags.key : dim,
    fact: redact(fact, config),
    source,
    confidence: Math.min(1, Math.max(0, confidence)),
    core: flags.core === true,
    scope: scopeKind,
    scopeId: scopeKind === 'global' ? undefined : activeScope(flags, config).id,
    session: typeof flags.session === 'string' ? flags.session : undefined,
  }
  if (flags.pending === true) {
    appendJsonl(p('pending.jsonl'), record)
    process.stdout.write(`已加入待审候选 [${dim}] ${record.fact}\n（确认：profile review --accept ${record.id}；或 review --accept all）\n`)
    return
  }
  appendJsonl(p('declarations.jsonl'), record)
  rebuildQuietly()
  process.stdout.write(`已记录 [${dim}] ${record.fact}\n（画像已刷新）\n`)
}

function cmdObserve({ flags }) {
  const config = loadConfig()
  const tools = typeof flags.tools === 'string'
    ? flags.tools.split(',').map((t) => t.trim()).filter(Boolean).map((tool) => ({ tool, count: 1 }))
    : []
  const record = {
    at: nowIso(),
    kind: 'turn',
    tools,
    steps: Number.isFinite(Number(flags.steps)) ? Number(flags.steps) : tools.length,
    ok: Number.isFinite(Number(flags.ok)) ? Number(flags.ok) : tools.length,
    fail: Number.isFinite(Number(flags.fail)) ? Number(flags.fail) : 0,
    durationMs: Number.isFinite(Number(flags.duration)) ? Number(flags.duration) : 0,
    scope: typeof flags.scope === 'string' && flags.scope.length > 0 ? flags.scope : 'global',
    scopeId: activeScope({}, config).id,
    manual: true,
  }
  const month = record.at.slice(0, 7)
  appendJsonl(join(p('observations'), `${month}.jsonl`), record)
  process.stdout.write(`已记录 1 轮行为信号（${tools.length} 个工具，ttl=${config.build.observedTtlDays}d）\n`)
}

function loadObservations(config, scope) {
  const dir = p('observations')
  if (!existsSync(dir)) return []
  const cutoff = Date.now() - config.build.observedTtlDays * 86400000
  const records = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const record of readJsonl(join(dir, file))) {
      const at = Date.parse(record?.at ?? '')
      if (!Number.isFinite(at) || at < cutoff) continue
      if (scope !== undefined && !inScope(record, scope)) continue
      records.push(record)
    }
  }
  return records.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

function aggregateObserved(records, config) {
  const toolCounts = new Map()
  const hourBuckets = new Map()
  let steps = 0
  let turns = 0
  let ok = 0
  let fail = 0
  for (const record of records) {
    turns += 1
    steps += Number(record.steps) || 0
    ok += Number(record.ok) || 0
    fail += Number(record.fail) || 0
    for (const entry of Array.isArray(record.tools) ? record.tools : []) {
      const tool = typeof entry === 'string' ? entry : entry?.tool
      if (typeof tool !== 'string' || tool.length === 0) continue
      // 'unknown' 是采集端拿不到工具名时的占位，不带信息量：
      // 老版本 bug 留下的 unknown 记录会挤掉真实工具占比，这里直接跳过。
      if (tool === 'unknown') continue
      const count = typeof entry?.count === 'number' ? entry.count : 1
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + count)
    }
    const hour = new Date(record.at).getHours()
    if (Number.isFinite(hour)) hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1)
  }
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const totalToolCalls = [...toolCounts.values()].reduce((sum, n) => sum + n, 0)
  const topHours = [...hourBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([hour]) => hour)
  const items = []
  const weight = config.build.observedWeight
  if (topTools.length > 0 && totalToolCalls > 0) {
    const share = topTools
      .map(([tool, count]) => `${tool} ${Math.round((count / totalToolCalls) * 100)}%`)
      .join('、')
    items.push({
      id: newId('obs'),
      kind: 'observed',
      key: 'habits.tools',
      text: `常用工具：${share}（近 ${turns} 轮，共 ${totalToolCalls} 次调用）`,
      weight,
      firstSeen: records[0]?.at,
      lastSeen: records[records.length - 1]?.at,
      scope: 'global',
      evidence: [],
    })
  }
  if (turns > 0 && steps > 0) {
    items.push({
      id: newId('obs'),
      kind: 'observed',
      key: 'habits.intensity',
      text: `单轮平均 ${round(steps / turns, 1)} 次工具调用，成功 ${ok} / 失败 ${fail}`,
      weight,
      firstSeen: records[0]?.at,
      lastSeen: records[records.length - 1]?.at,
      scope: 'global',
      evidence: [],
    })
  }
  if (topHours.length > 0) {
    items.push({
      id: newId('obs'),
      kind: 'observed',
      key: 'habits.rhythm',
      text: `活跃时段集中在 ${topHours.map((h) => `${String(h).padStart(2, '0')}:00`).join('、')} 前后`,
      weight,
      firstSeen: records[0]?.at,
      lastSeen: records[records.length - 1]?.at,
      scope: 'global',
      evidence: [],
    })
  }
  // 上面三项（工具占比 / 单轮步数 / 活跃时段）是 Agent 的运行统计，不是「用户是谁」。
  // 默认不当作画像条目产出；turns/steps/ok/fail 仍返回，供「证据够不够」这类内部判断使用。
  const withItems = config.build?.includeObservedItems === true
  return { items: withItems ? items : [], turns, steps, ok, fail, totalToolCalls }
}

/** 归一化：只留中英文与数字，压掉标点空白，用于判重。 */
const normText = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

/** 字符二元组 Dice 系数：0 完全不同，1 完全相同。中文按字切片足够用。 */
function similarity(a, b) {
  const x = normText(a)
  const y = normText(b)
  if (x.length === 0 || y.length === 0) return 0
  if (x === y) return 1
  const grams = (s) => {
    if (s.length === 1) return [s]
    const out = []
    for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2))
    return out
  }
  const gx = grams(x)
  const pool = new Map()
  for (const g of grams(y)) pool.set(g, (pool.get(g) ?? 0) + 1)
  let hit = 0
  for (const g of gx) {
    const n = pool.get(g) ?? 0
    if (n > 0) {
      hit += 1
      pool.set(g, n - 1)
    }
  }
  return (2 * hit) / (gx.length + grams(y).length)
}

function buildDimensions(declarations, observed, config) {
  const dimensions = {}
  for (const dim of config.dimensions) {
    dimensions[dim] = { label: labelOf(dim, config), items: [], history: [] }
  }
  const bucket = (dim) => {
    if (!dimensions[dim]) dimensions[dim] = { label: labelOf(dim, config), items: [], history: [] }
    return dimensions[dim]
  }

  // 声明型：按 key 归并；冲突按 config.conflicts.strategy 处理
  const byKey = new Map()
  for (const record of declarations) {
    if (typeof record?.fact !== 'string' || record.fact.trim().length === 0) continue
    const dim = typeof record.dim === 'string' ? record.dim : 'taste'
    const key = `${dim}::${record.key ?? dim}`
    const list = byKey.get(key) ?? []
    list.push(record)
    byKey.set(key, list)
  }
  const strategy = config.conflicts?.strategy === 'freeze' ? 'freeze' : 'newest'
  const conflicts = []
  for (const [key, list] of byKey) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    const latest = list[list.length - 1]
    const dim = typeof latest.dim === 'string' ? latest.dim : 'taste'
    const target = bucket(dim)
    const shape = (record, extra = {}) => ({
      id: record.id ?? newId('dcl'),
      kind: 'declared',
      key: record.key ?? dim,
      dim,
      text: record.fact,
      weight: typeof record.confidence === 'number' ? record.confidence : 1,
      source: record.source ?? 'user',
      core: record.core === true,
      scope: record.scope ?? 'global',
      scopeId: record.scopeId,
      firstSeen: record.at,
      lastSeen: record.at,
      ...extra,
    })
    target.items.push(shape(latest, { firstSeen: list[0].at, lastSeen: latest.at, evidence: list.map((r) => r.id).filter(Boolean) }))

    const previous = list[list.length - 2]
    if (previous !== undefined && previous.fact !== latest.fact) {
      if (strategy === 'freeze') {
        // 冻结：两条都留在 items，标 frozen；注入时并排展示，等用户裁决
        target.items[target.items.length - 1].frozen = true
        target.items.push(shape(previous, { frozen: true }))
        conflicts.push({
          dim,
          key: latest.key ?? dim,
          status: 'frozen',
          rule: 'conflicts.strategy=freeze：两条并留、不选边，等 profile review 裁决',
          from: { id: previous.id, text: previous.fact, at: previous.at },
          to: { id: latest.id, text: latest.fact, at: latest.at },
        })
      } else {
        target.history.push({
          id: previous.id ?? newId('dcl'),
          kind: 'declared',
          key: previous.key ?? dim,
          text: previous.fact,
          firstSeen: previous.at,
          lastSeen: previous.at,
          supersededBy: latest.id,
        })
        conflicts.push({
          dim,
          key: latest.key ?? dim,
          status: 'resolved',
          rule: 'declared 新值覆盖旧值；旧值保留在 history',
          from: { id: previous.id, text: previous.fact, at: previous.at },
          to: { id: latest.id, text: latest.fact, at: latest.at },
        })
      }
    }
  }

  // 行为型：只进 habits，权重低，可被声明型压住
  for (const item of observed.items) {
    bucket('habits').items.push({ ...item, dim: 'habits' })
  }

  // 同维度去重：模型每轮都可能用不同 key 重述同一件事，不合并画像会越用越肿。
  // 只留权重最高的那条，其余进 history 并记 status='merged'，不丢证据。
  if (config.build?.dedupe !== false) {
    const threshold = Number(config.build?.similarityThreshold ?? 0.45)
    for (const [dim, section] of Object.entries(dimensions)) {
      const declared = section.items.filter((it) => it.kind === 'declared' && it.frozen !== true)
      if (declared.length < 2) continue
      const keep = []
      for (const item of declared) {
        const twin = keep.find((k) => similarity(k.text, item.text) >= threshold)
        if (twin === undefined) {
          keep.push(item)
          continue
        }
        const winner = (item.weight ?? 0) > (twin.weight ?? 0) ? item : twin
        const loser = winner === item ? twin : item
        winner.evidence = [...new Set([...(winner.evidence ?? []), ...(loser.evidence ?? [])])]
        if (String(loser.firstSeen) < String(winner.firstSeen)) winner.firstSeen = loser.firstSeen
        keep[keep.indexOf(twin)] = winner
        section.history.push({
          id: loser.id,
          kind: 'declared',
          key: loser.key,
          text: loser.text,
          firstSeen: loser.firstSeen,
          lastSeen: loser.lastSeen,
          supersededBy: winner.id,
          mergedAs: 'duplicate',
        })
        conflicts.push({
          dim,
          key: winner.key,
          status: 'merged',
          rule: `相似度 ≥ ${threshold} 视为同一件事；保留权重更高的那条，另一条进 history`,
          from: { id: loser.id, text: loser.text, at: loser.lastSeen },
          to: { id: winner.id, text: winner.text, at: winner.lastSeen },
        })
      }
      section.items = [...keep, ...section.items.filter((it) => it.kind !== 'declared' || it.frozen === true)]
    }
  }

  for (const section of Object.values(dimensions)) {
    section.items.sort(rankItem)
  }
  return { dimensions, conflicts }
}

/** 扁平视图：注入与面板共用，避免两处各算一遍排序。 */
function flatten(profile, config) {
  const out = []
  for (const [dim, section] of Object.entries(profile.dimensions ?? {})) {
    for (const item of Array.isArray(section.items) ? section.items : []) {
      out.push({ ...item, dim, dimLabel: section.label ?? dim, core: isCore({ ...item, dim }, config) })
    }
  }
  return out.sort(rankItem)
}

function renderMarkdown(profile, config) {
  const lines = []
  lines.push(`# 用户画像 v${profile.revision}`)
  lines.push('')
  lines.push(`> 状态：${profile.status} · 生成于 ${profile.builtAt}`)
  lines.push(`> 依据：${profile.stats.declarations} 条已确认${profile.stats.modelFacts ? `（其中 ${profile.stats.modelFacts} 条由模型提炼）` : ''} · ${profile.stats.turns} 轮对话`)
  if (typeof profile.stats.pending === 'number' && profile.stats.pending > 0) {
    lines.push(`> 待审候选：${profile.stats.pending} 条（profile review 查看）`)
  }
  lines.push('')
  if (profile.status === 'empty') {
    lines.push('（暂无数据：尚未记录任何声明型事实或行为信号。）')
  } else if (profile.status === 'insufficient') {
    lines.push(`（数据不足：至少需要 ${profile.stats.minEvidence} 条证据才能建立画像，当前 ${profile.stats.evidence} 条。）`)
  }
  for (const [dim, section] of Object.entries(profile.dimensions ?? {})) {
    const items = (Array.isArray(section.items) ? [...section.items] : []).sort(rankItem)
    if (items.length === 0) continue
    lines.push('')
    lines.push(`## ${section.label ?? dim}`)
    for (const item of items) {
      const tag = item.kind === 'declared' ? '已确认' : '我的观察'
      const core = isCore({ ...item, dim }, config) ? '核心 · ' : ''
      const frozen = item.frozen === true ? ' · 未决' : ''
      const scope = item.scope && item.scope !== 'global' ? ` · ${item.scope}${item.scopeId ? `:${item.scopeId}` : ''}` : ''
      lines.push(`- [${core}${tag} ${round(item.weight ?? 0, 2)}${frozen}${scope}] ${item.text}`)
    }
  }
  const openConflicts = (profile.conflicts ?? []).filter((c) => c.status !== 'resolved' && c.status !== 'merged')
  if (openConflicts.length > 0) {
    lines.push('')
    lines.push('## 待确认冲突')
    for (const conflict of openConflicts) {
      const label = conflict.status === 'frozen' ? '已冻结' : '未决'
      lines.push(`- ${conflict.dim}/${conflict.key}：A「${conflict.from.text}」 vs B「${conflict.to.text}」 → ${label}，注入时不选边`)
    }
  }
  // 自动合并掉的同义条目单独交代一句：用户会好奇「我说的另一句去哪了」。
  const merged = (profile.conflicts ?? []).filter((c) => c.status === 'merged')
  if (merged.length > 0) {
    lines.push('')
    lines.push(`## 已合并同义条目 · ${merged.length} 条`)
    for (const conflict of merged) {
      lines.push(`- ${conflict.dim}/${conflict.key}：「${conflict.from.text}」与「${conflict.to.text}」判为同一件事，保留权重更高的那条；另一条留在 history 里，可用 profile show 查看`)
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * 三段式注入文本（v7）：
 *   一、红线与硬要求 —— constraints 维度或显式 --core，任何时候都遵守，最优先分预算；
 *   二、个性化首选 —— taste / communication / habits / interests（可配），
 *      凡本轮涉及风格、口味、默认选择、文案、推荐、界面，这些就是**主要依据**；
 *   三、背景参考 —— 其余按权重排序，用来少问问题、选默认值。
 * 三段各有预算帽，条目涨到几百条时红线也不会被 maxChars 的硬截断砍掉。
 *
 * 为什么要把「个性化首选」单列一段：整块画像被当成「背景知识」时，模型只会「参考一下」；
 * 单列并在标题里写明「主要依据」，个性化需求才真的落到这些条目上。
 */
function renderInject(profile, config) {
  const limit = Number.isFinite(config.inject?.maxChars) && config.inject.maxChars > 0
    ? config.inject.maxChars
    : DEFAULT_CONFIG.inject.maxChars
  const topK = Number.isFinite(config.inject?.topK) && config.inject.topK > 0
    ? config.inject.topK
    : DEFAULT_CONFIG.inject.topK
  const prioritize = config.inject?.priorityOnPersonalize !== false
  const personalizeDims = prioritize && Array.isArray(config.inject?.personalizeDimensions)
    ? config.inject.personalizeDimensions
    : (prioritize ? DEFAULT_CONFIG.inject.personalizeDimensions : [])

  const all = flatten(profile, config)
  const redline = all.filter((item) => item.core)
  const personalize = all.filter((item) => !item.core && personalizeDims.includes(item.dim))
  const rest = all.filter((item) => !item.core && !personalizeDims.includes(item.dim)).slice(0, topK)

  const lineOf = (item) => {
    const kind = item.kind === 'declared' ? '已确认' : '我的观察'
    const frozen = item.frozen === true ? ' ·未决' : ''
    const scope = item.scope && item.scope !== 'global' ? ` ·${item.scope}` : ''
    return `- [${item.dimLabel} ${round(item.weight ?? 0, 2)}${frozen}${scope}·${kind}] ${item.text}`
  }

  const total = redline.length + personalize.length + rest.length
  // 这里只放「数据」：版本、时间、条数。使用规则（谁优先、什么时候当主要依据）
  // 是插件内部规定，写在 index.js 的 PLUGIN_POLICY 里，不落进画像文件，
  // 也不随画像被编辑/删除而改变。
  const head = [
    `# 用户画像 v${profile.revision}`,
    `> 生成于 ${profile.builtAt} · 共 ${profile.stats?.items ?? all.length} 条，本次带入 ${total} 条`,
    '',
  ]

  const body = [...head]
  let used = head.join('\n').length

  /** 逐段压预算：red 占 40%，personalize 累计 75%，其余吃满 limit。 */
  const pushSection = (title, items, cap, noteWhenCut) => {
    if (items.length === 0) return
    const header = `${title}`
    body.push(header)
    used += header.length + 1
    let cut = 0
    for (const item of items) {
      const line = lineOf(item)
      if (used + line.length + 1 > cap) {
        cut += 1
        continue
      }
      body.push(line)
      used += line.length + 1
    }
    if (cut > 0 && noteWhenCut !== undefined) body.push(noteWhenCut(cut))
    body.push('')
  }

  pushSection(
    '## 一、红线与硬要求',
    redline,
    Math.floor(limit * 0.4),
    (cut) => `（红线还有 ${cut} 条没放下：调大 inject.maxChars，或收窄 inject.coreDimensions）`,
  )
  pushSection(
    '## 二、个性化首选',
    personalize,
    Math.floor(limit * 0.75),
    (cut) => `（个性化条目还有 ${cut} 条没放下：调大 inject.maxChars 或 inject.topK）`,
  )
  pushSection('## 三、背景参考', rest, limit, (cut) =>
    `（另有 ${cut} 条按预算裁掉；调 inject.maxChars / inject.topK 可放宽）`)

  if (profile.stats.pending > 0) {
    body.push(`（有 ${profile.stats.pending} 条待审候选未进画像）`)
  }
  return `${body.join('\n').trimEnd()}\n`
}

function countPending() {
  return readJsonl(p('pending.jsonl')).length
}

function cmdBuild({ flags }) {
  const config = loadConfig()
  ensureDirs()
  const scope = activeScope(flags, config)
  const declarations = readJsonl(p('declarations.jsonl')).filter((r) => inScope(r, scope))
  const observations = loadObservations(config, scope)
  const observed = aggregateObserved(observations, config)
  const { dimensions, conflicts } = buildDimensions(declarations, observed, config)
  const evidence = declarations.length + observed.turns
  const previous = readJson(p('profile.json'), {})
  const status = evidence === 0
    ? 'empty'
    : evidence < config.build.minEvidenceForPortrait ? 'insufficient' : 'ready'
  const profile = {
    schemaVersion: 2,
    revision: (Number(previous?.revision) || 0) + 1,
    builtAt: nowIso(),
    status,
    scope: { id: scope.id, includeAll: scope.includeAll },
    privacy: { mode: config.redaction.mode, rules: config.redaction.patterns.length },
    policy: {
      strategy: config.conflicts?.strategy ?? 'newest',
      coreDimensions: config.inject.coreDimensions,
      topK: config.inject.topK,
      maxChars: config.inject.maxChars,
    },
    stats: {
      declarations: declarations.length,
      modelFacts: declarations.filter((r) => r?.source === 'model').length,
      turns: observed.turns,
      steps: observed.steps,
      toolCalls: observed.totalToolCalls,
      ok: observed.ok,
      fail: observed.fail,
      evidence,
      minEvidence: config.build.minEvidenceForPortrait,
      observedTtlDays: config.build.observedTtlDays,
      pending: countPending(),
      items: Object.values(dimensions).reduce((n, s) => n + s.items.length, 0),
    },
    dimensions,
    conflicts,
  }
  writeJson(p('profile.json'), profile)
  writeFileSync(p('profile.md'), renderMarkdown(profile, config), 'utf8')
  writeFileSync(p('inject.md'), renderInject(profile, config), 'utf8')
  appendJsonl(p('changelog.jsonl'), {
    at: profile.builtAt,
    revision: profile.revision,
    status,
    evidence,
    declarations: declarations.length,
    turns: observed.turns,
    conflicts: conflicts.length,
    pending: profile.stats.pending,
    scope: scope.includeAll ? 'all' : scope.id,
  })
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
  } else {
    process.stdout.write(renderMarkdown(profile, config))
  }
}

function cmdShow({ flags }) {
  if (flags.json === true) {
    const profile = readJson(p('profile.json'), undefined)
    if (profile === undefined) die('还没有画像；先运行 build')
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
    return
  }
  if (flags.inject === true) {
    if (!existsSync(p('inject.md'))) die('还没有注入文本；先运行 build')
    process.stdout.write(readFileSync(p('inject.md'), 'utf8'))
    return
  }
  if (!existsSync(p('profile.md'))) die('还没有画像；先运行 build')
  process.stdout.write(readFileSync(p('profile.md'), 'utf8'))
}

function cmdPanel() {
  const config = loadConfig()
  const profile = readJson(p('profile.json'), undefined)
  const pending = readJsonl(p('pending.jsonl'))
  const items = profile === undefined ? [] : flatten(profile, config)
  // 画像还没生成时，证据行必须显示「真实采集量」，否则面板会撒谎成「行为 0 轮」，
  // 让人以为采集没生效 —— 实际只是从没 build。
  const liveDeclarations = readJsonl(p('declarations.jsonl'))
  const liveStats = {
    declarations: liveDeclarations.length,
    // 其中有多少是大模型自动提炼出来的：这是「智能提取」是否真的在跑的证据。
    modelFacts: liveDeclarations.filter((r) => r?.source === 'model').length,
    pending: pending.length,
  }
  // 一致性自检：画像里统计的声明数 vs 磁盘上真实的条数。
  // 两者不等说明画像过期（有人写数据但没 build），面板必须说出来，别让人看着旧画像猜。
  const builtDeclarations = typeof profile?.stats?.declarations === 'number' ? profile.stats.declarations : null
  const drift = builtDeclarations === null
    ? { stale: false, built: null, live: liveDeclarations.length }
    : {
      stale: builtDeclarations !== liveDeclarations.length,
      built: builtDeclarations,
      live: liveDeclarations.length,
    }
  const payload = {
    ok: true,
    // 面板上的命令提示必须能直接复制执行：插件 bin 不在 PATH 里，别给裸命令名。
    cli: { node: process.execPath, script: fileURLToPath(import.meta.url) },
    config: {
      enabled: config.enabled,
      mode: config.inject.mode,
      maxChars: config.inject.maxChars,
      topK: config.inject.topK,
      coreDimensions: config.inject.coreDimensions,
      strategy: config.conflicts.strategy,
      autoBuild: config.build.autoBuild !== false,
      // 语义提取开关与门限：面板要能一眼看出「智能提取有没有在干活」。
      extract: {
        enabled: config.extract?.enabled !== false,
        everyTurns: config.extract?.everyTurns ?? 1,
        autoAcceptConfidence: config.extract?.autoAcceptConfidence ?? 0.6,
        readTurnText: config.capture?.turnText !== false,
      },
    },
    // 面板的「新增」下拉需要维度清单（含自定义维度）
    dimensions: config.dimensions.map((dim) => ({
      id: dim,
      label: labelOf(dim, config),
      hint: DIMENSION_HINTS[dim] ?? '自定义大类',
      keys: DIMENSIONS.find((d) => d.id === dim)?.keys ?? [],
    })),
    profile: profile === undefined
      ? { status: 'missing', revision: 0, builtAt: null, stats: liveStats }
      : {
        status: profile.status,
        revision: profile.revision,
        builtAt: profile.builtAt,
        stats: profile.stats,
        scope: profile.scope,
      },
    live: liveStats,
    drift,
    items: items.map((item, index) => ({
      rank: index + 1,
      id: item.id,
      dim: item.dim,
      dimLabel: item.dimLabel,
      key: item.key,
      kind: item.kind,
      text: item.text,
      weight: round(item.weight ?? 0, 2),
      core: item.core === true,
      frozen: item.frozen === true,
      scope: item.scope ?? 'global',
      scopeId: item.scopeId ?? null,
      firstSeen: item.firstSeen ?? null,
      lastSeen: item.lastSeen ?? null,
    })),
    conflicts: (profile?.conflicts ?? []).map((c) => ({ ...c })),
    pending: pending.map((r) => ({
      id: r.id,
      dim: r.dim,
      fact: r.fact,
      at: r.at,
      source: r.source ?? 'user',
      confidence: r.confidence ?? 1,
      scope: r.scope ?? 'global',
    })),
  }
  // ---- 面板用的统计：只算「用户看得懂的东西」 ----
  // 早先这里还现算了按天活跃、工具构成、活跃小时，那是给开发期自检用的，
  // 摆到用户面前只会让人问「我没用过 pwsh，这算什么画像」，所以整段删掉了。
  const dimCounts = {}
  for (const item of payload.items) {
    const cell = dimCounts[item.dim] ?? { declared: 0, observed: 0 }
    cell[item.kind === 'declared' ? 'declared' : 'observed'] += 1
    dimCounts[item.dim] = cell
  }
  const weights = payload.items.map((item) => Number(item.weight ?? 0))
  const bucket = (test) => weights.filter(test).length
  const weightBuckets = [
    { label: '≥0.9', n: bucket((w) => w >= 0.9) },
    { label: '0.6–0.9', n: bucket((w) => w >= 0.6 && w < 0.9) },
    { label: '0.45–0.6', n: bucket((w) => w >= 0.45 && w < 0.6) },
    { label: '<0.45', n: bucket((w) => w < 0.45) },
  ]

  const conflictsAll = profile?.conflicts ?? []
  const conflictStats = {
    merged: conflictsAll.filter((c) => c.status === 'merged').length,
    resolved: conflictsAll.filter((c) => c.status === 'resolved').length,
    frozen: conflictsAll.filter((c) => c.status === 'frozen').length,
    open: conflictsAll.filter((c) => c.status !== 'merged' && c.status !== 'resolved').length,
  }

  // 被替换/合并掉的历史条目：用户会问「我说的那句去哪了」，这里给出去向。
  const historyItems = []
  for (const [dim, section] of Object.entries(profile?.dimensions ?? {})) {
    for (const entry of section?.history ?? []) {
      historyItems.push({
        dim,
        dimLabel: labelOf(dim, config),
        id: entry.id ?? null,
        text: entry.text ?? '',
        supersededBy: entry.supersededBy ?? null,
        mergedAs: entry.mergedAs ?? null,
        firstSeen: entry.firstSeen ?? null,
        lastSeen: entry.lastSeen ?? null,
      })
    }
  }
  historyItems.sort((a, b) => (String(a.lastSeen) < String(b.lastSeen) ? 1 : -1))

  const enriched = {
    ...payload,
    // 完整配置：设置页每个字段都要能改，所以这里给全，而不是只给面板要显示的那几个。
    settings: {
      enabled: config.enabled,
      inject: {
        mode: config.inject.mode,
        maxChars: config.inject.maxChars,
        topK: config.inject.topK,
        coreDimensions: [...config.inject.coreDimensions],
        personalizeDimensions: [...(config.inject.personalizeDimensions ?? DEFAULT_CONFIG.inject.personalizeDimensions)],
        priorityOnPersonalize: config.inject.priorityOnPersonalize !== false,
        distillHint: config.inject.distillHint !== false,
        announceSuppressed: config.inject.announceSuppressed !== false,
      },
      conflicts: { strategy: config.conflicts.strategy },
      build: {
        minEvidenceForPortrait: config.build.minEvidenceForPortrait,
        observedTtlDays: config.build.observedTtlDays,
        declaredWeight: config.build.declaredWeight,
        observedWeight: config.build.observedWeight,
        autoBuild: config.build.autoBuild !== false,
        autoBuildMinIntervalMs: config.build.autoBuildMinIntervalMs,
        dedupe: config.build.dedupe !== false,
        similarityThreshold: config.build.similarityThreshold,
      },
      extract: {
        enabled: config.extract?.enabled !== false,
        everyTurns: config.extract?.everyTurns ?? 1,
        autoAcceptConfidence: config.extract?.autoAcceptConfidence ?? 0.6,
        maxFactsPerTurn: config.extract?.maxFactsPerTurn ?? 5,
        timeoutMs: config.extract?.timeoutMs ?? 45000,
      },
      capture: { turnText: config.capture?.turnText !== false },
      redaction: { mode: config.redaction.mode, patternCount: (config.redaction.patterns ?? []).length },
      scope: { id: activeScope({}, config).id },
    },
    stats: {
      items: payload.items.length,
      declared: liveStats.declarations,
      modelFacts: liveStats.modelFacts,
      core: payload.items.filter((item) => item.core).length,
      pending: payload.pending.length,
      dimCounts,
      weightBuckets,
      conflictStats,
      history: historyItems.length,
    },
    history: historyItems.slice(0, 30),
    // 快照列表：面板的「恢复」需要知道有哪些可回退点。
    snapshots: listSnapshots(12),
  }
  process.stdout.write(`${JSON.stringify(enriched)}\n`)
}

/**
 * 改完数据立刻重算画像。
 * 不重算的话面板与注入还停在旧快照，用户点「删除」会看到条目原地不动 —— 看起来就是「删除功能失效」。
 */
function rebuildQuietly() {
  try {
    cmdBuild({ flags: { 'all-scopes': true } })
  } catch (error) {
    process.stderr.write(`画像重建失败：${error?.message ?? error}（数据已改，可手动 build 刷新）\n`)
  }
}

function cmdReview({ flags }) {
  const config = loadConfig()
  const pending = readJsonl(p('pending.jsonl'))
  const target = typeof flags.accept === 'string' ? flags.accept
    : typeof flags.reject === 'string' ? flags.reject
      : undefined

  if (target === undefined) {
    if (pending.length === 0) {
      process.stdout.write('没有待审候选。\n')
      return
    }
    process.stdout.write(`待审候选 ${pending.length} 条：\n\n`)
    for (const record of pending) {
      process.stdout.write(`  ${record.id}  [${record.dim}] ${record.fact}\n`)
    }
    process.stdout.write(`\n确认：profile review --accept <id|all>\n丢弃：profile review --reject <id|all>\n`)
    return
  }

  const accept = typeof flags.accept === 'string'
  const picked = target === 'all' ? pending : pending.filter((r) => r.id === target)
  if (picked.length === 0) die(`没有匹配的候选：${target}`)
  const pickedIds = new Set(picked.map((r) => r.id))

  if (accept) {
    for (const record of picked) {
      appendJsonl(p('declarations.jsonl'), { ...record, acceptedAt: nowIso() })
    }
  }
  writeJsonl(p('pending.jsonl'), pending.filter((r) => !pickedIds.has(r.id)))
  rebuildQuietly()
  process.stdout.write(`${accept ? '已接受' : '已丢弃'} ${picked.length} 条候选（画像已刷新）\n`)
}

/**
 * 删除/合并前留一份快照。批量删在面板上是「逐条动作循环」，一次手滑就能把画像清空 ——
 * 有快照才能一条命令捞回来（`import --file snapshots/...`）。
 */
function snapshotDeclarations(tag) {
  try {
    const file = p('declarations.jsonl')
    if (!existsSync(file)) return
    const dir = p('snapshots')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const dest = join(dir, `declarations-${tag}-${Date.now()}.jsonl`)
    copyFileSync(file, dest)
    const olds = readdirSync(dir)
      .filter((name) => name.startsWith(`declarations-${tag}-`))
      .sort()
    while (olds.length > 20) {
      const victim = olds.shift()
      try {
        unlinkSync(join(dir, victim))
      } catch {
        // 删不掉旧快照不影响本次
      }
    }
  } catch {
    // 快照失败不阻止删除：先保证用户点的操作生效
  }
}

/** 快照清单（新的在前）：面板「恢复」与 status 都读它。 */
function listSnapshots(limit = 20) {
  try {
    const dir = p('snapshots')
    if (!existsSync(dir)) return []
    const rows = readdirSync(dir)
      .filter((name) => /^declarations-[\w.-]+\.jsonl$/.test(name))
      .map((name) => {
        const file = join(dir, name)
        let count = 0
        let last = null
        try {
          const records = readJsonl(file)
          count = records.length
          last = records.length > 0 ? records[records.length - 1].at ?? null : null
        } catch {
          count = -1
        }
        const tag = name.replace(/^declarations-/, '').replace(/-\d+\.jsonl$/, '')
        return { name, tag, count, last, bytes: readFileSync(file, 'utf8').length }
      })
      .sort((a, b) => b.name.localeCompare(a.name))
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

function cmdForget({ flags }) {
  const id = typeof flags.id === 'string' ? flags.id : ''
  const key = typeof flags.key === 'string' ? flags.key : ''
  const dim = typeof flags.dim === 'string' ? flags.dim : ''
  const all = flags.all === true || id === 'all'
  const inPending = flags.pending === true

  if (!all && id === '' && key === '' && dim === '') {
    die('用法：forget --id <id> | --key <key> | --dim <维度> | --all [--pending]')
  }

  const file = inPending ? p('pending.jsonl') : p('declarations.jsonl')
  const records = readJsonl(file)
  const hit = (r) => {
    if (all) return true
    if (id !== '' && r.id === id) return true
    if (key !== '' && r.key === key) return true
    // --dim 只在额外给了 --key 之外的显式意图时才按维度清空，避免手滑清掉一整维
    if (dim !== '' && r.dim === dim) return true
    return false
  }
  const kept = records.filter((r) => !hit(r))
  const removed = records.length - kept.length
  if (removed === 0) die('没有匹配的记录（什么都没删）')
  if (!inPending) snapshotDeclarations('forget')
  writeJsonl(file, kept)
  rebuildQuietly()
  const where = inPending ? '待审候选' : '声明'
  process.stdout.write(`已删除 ${removed} 条${where}（剩余 ${kept.length} 条；画像已刷新）\n`)
}

/** 既然记录是 append-only，改一条 = 先删后加：旧值进 changelog，便于回溯。 */
function cmdEdit({ flags }) {
  const id = typeof flags.id === 'string' ? flags.id : ''
  if (id.length === 0) die('用法：edit --id <id> [--fact 新内容] [--dim 维度] [--key key] [--weight 0..1] [--core true|false]')
  const config = loadConfig()
  const records = readJsonl(p('declarations.jsonl'))
  const record = records.find((r) => r.id === id)
  if (record === undefined) die(`没有这条声明：${id}`)

  const before = { ...record }
  if (typeof flags.fact === 'string' && flags.fact.trim().length > 0) record.fact = redact(flags.fact.trim(), config)
  if (typeof flags.dim === 'string' && flags.dim.length > 0) {
    if (!config.dimensions.includes(flags.dim)) die(`未知维度 ${flags.dim}；可用：${config.dimensions.join(', ')}`)
    record.dim = flags.dim
  }
  if (typeof flags.key === 'string' && flags.key.length > 0) record.key = flags.key
  // --weight 是 --confidence 的别名：面板上叫「权重」，命令行两套词都认。
  const nextWeight = Number.isFinite(Number(flags.weight))
    ? Number(flags.weight)
    : Number.isFinite(Number(flags.confidence)) ? Number(flags.confidence) : NaN
  if (Number.isFinite(nextWeight)) record.confidence = Math.min(1, Math.max(0, nextWeight))
  if (typeof flags.core === 'boolean') record.core = flags.core
  else if (flags.core === 'true' || flags.core === 'false') record.core = flags.core === 'true'
  record.editedAt = nowIso()
  // 改完要当作「最新」参与冲突裁决，否则同 key 的旧值会继续压住它
  record.at = record.editedAt

  writeJsonl(p('declarations.jsonl'), records)
  appendJsonl(p('changelog.jsonl'), { at: record.editedAt, kind: 'edit', id, before, after: { ...record } })
  rebuildQuietly()
  process.stdout.write(`已修改 ${id}：[${record.dim}] ${record.fact}\n（画像已刷新）\n`)
}

/**
 * 手动合并两条声明：保留 keep 的内容，把 drop 并进来。
 * 自动去重只认字面相似度，语义相同但措辞差太远的（比如「每个插件只做一件事」和
 * 「不同插件职责分离」）得让人自己判——所以给一个明确的、可审计的合并动作。
 */
function cmdMerge({ flags }) {
  const keepId = typeof flags.keep === 'string' ? flags.keep : ''
  const dropId = typeof flags.drop === 'string' ? flags.drop : ''
  if (keepId.length === 0 || dropId.length === 0) die('用法：merge --keep <id> --drop <id>')
  if (keepId === dropId) die('--keep 与 --drop 不能是同一条')
  const records = readJsonl(p('declarations.jsonl'))
  const keep = records.find((r) => r.id === keepId)
  const drop = records.find((r) => r.id === dropId)
  if (keep === undefined) die(`没有 id=${keepId} 的声明`)
  if (drop === undefined) die(`没有 id=${dropId} 的声明`)
  const merged = {
    ...keep,
    at: nowIso(),
    editedAt: nowIso(),
    mergedFrom: [...(Array.isArray(keep.mergedFrom) ? keep.mergedFrom : []), { id: drop.id, dim: drop.dim, fact: drop.fact }],
  }
  writeJsonl(p('declarations.jsonl'), records.filter((r) => r.id !== dropId).map((r) => (r.id === keepId ? merged : r)))
  appendJsonl(p('changelog.jsonl'), {
    at: nowIso(),
    kind: 'merge',
    keep: keepId,
    drop: dropId,
    before: { keep: keep.fact, drop: drop.fact },
  })
  rebuildQuietly()
  process.stdout.write(`已合并：保留「${keep.fact}」，并入「${drop.fact}」\n（画像已刷新）\n`)
}

/** 批量导入：JSON 数组或 { items: [...] }，字段与 declare 一致。 */
function cmdImport({ flags }) {
  const file = typeof flags.file === 'string' ? flags.file : ''
  if (file.length === 0) die('用法：import --file <path.json> [--pending]')
  if (!existsSync(file)) die(`找不到文件：${file}`)
  const config = loadConfig()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 也接受自家存储格式（JSONL，一行一条）—— 快照与备份都是这个形状，
    // 恢复时不该逼人先手工转成数组。
    const lines = readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
    const rowsFromLines = []
    for (const line of lines) {
      try {
        rowsFromLines.push(JSON.parse(line))
      } catch {
        // 坏行跳过，由下面的计数报出来
      }
    }
    if (rowsFromLines.length === 0) die('文件既不是 JSON 数组，也不是一行一条 JSON 的 JSONL')
    parsed = rowsFromLines
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  if (rows.length === 0) die('文件里没有可导入的条目（需要数组或 { items: [...] }）')

  let added = 0
  let skipped = 0
  for (const row of rows) {
    const fact = typeof row?.fact === 'string' ? row.fact.trim() : ''
    const rawDim = typeof row?.dim === 'string' ? row.dim : 'taste'
    // 老快照里的维度名（preferences/expertise/workflow…）不能直接丢：先按内容重新归类。
    // 但不认识的字符串（拼错的、别处来的）不该被静默塞进 taste —— 那会把导入变成污染，
    // 只对已知的老维度名做重归类，其余一律计入「跳过」。
    const known = config.dimensions.includes(rawDim)
    const legacy = LEGACY_DIMENSION_MAP[rawDim] !== undefined
    const dim = known ? rawDim : legacy ? classifyLegacy({ ...row, dim: rawDim }) : ''
    if (fact.length === 0 || dim.length === 0 || !config.dimensions.includes(dim)) {
      skipped += 1
      continue
    }
    const source = row?.source === 'model' ? 'model' : 'user'
    const confidence = Number.isFinite(Number(row?.confidence))
      ? Math.min(1, Math.max(0, Number(row.confidence)))
      : (source === 'user' ? 1 : 0.6)
    const record = {
      id: newId('dcl'),
      at: nowIso(),
      dim,
      key: typeof row?.key === 'string' && row.key.length > 0 ? row.key : dim,
      fact: redact(fact, config),
      source,
      confidence,
      core: row?.core === true,
      scope: 'global',
      importedFrom: file,
    }
    appendJsonl(flags.pending === true ? p('pending.jsonl') : p('declarations.jsonl'), record)
    added += 1
  }
  rebuildQuietly()
  process.stdout.write(`导入 ${added} 条，跳过 ${skipped} 条（空内容或未知维度）；画像已刷新\n`)
}

/** 自定义维度：id 用英文小写，标签随便写中文。 */
function cmdDims({ positional }) {
  const [action, id, label] = positional
  const config = loadConfig()
  if (action === undefined || action === 'list') {
    process.stdout.write('画像大类（一类只回答一个问题；key 用「维度.细分」）\n\n')
    for (const dim of config.dimensions) {
      const custom = config.dimensionLabels?.[dim] !== undefined
      const hint = DIMENSION_HINTS[dim]
      process.stdout.write(`  ${dim.padEnd(16)} ${labelOf(dim, config)}${custom ? '（自定义）' : ''}\n`)
      if (hint !== undefined) process.stdout.write(`  ${''.padEnd(16)} ${hint}\n`)
    }
    process.stdout.write('\n增量：profile dims add <id> <标签> / profile dims remove <id>\n')
    return
  }
  if (action === 'add') {
    if (id === undefined || label === undefined) die('用法：dims add <id> <标签>')
    if (!/^[a-z][a-z0-9_-]{1,23}$/.test(id)) die('维度 id 只能用小写字母/数字/下划线，2–24 字符')
    if (!config.dimensions.includes(id)) config.dimensions.push(id)
    config.dimensionLabels = { ...(config.dimensionLabels ?? {}), [id]: String(label) }
    saveConfig(config)
    rebuildQuietly()
    process.stdout.write(`已添加维度 ${id} = ${label}\n`)
    return
  }
  if (action === 'move') {
    // 大类合并：把 from 下的所有条目搬到 to，条目本身不删（删维度不该连带丢数据）
    if (id === undefined || label === undefined) die('用法：dims move <from> <to>')
    const to = label
    if (!config.dimensions.includes(id)) die(`没有这个大类：${id}`)
    if (!config.dimensions.includes(to)) die(`没有这个大类：${to}`)
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
      process.stdout.write(`大类 ${id} 下没有条目，无需移动\n`)
      return
    }
    try { snapshotDeclarations('dims-move') } catch { /* 快照失败不阻塞主流程 */ }
    writeJsonl(p('declarations.jsonl'), next)
    appendJsonl(p('changelog.jsonl'), { at, kind: 'dims-move', from: id, to, moved })
    rebuildQuietly()
    process.stdout.write(`已把 ${moved} 条从 ${id} 移到 ${to}（画像已刷新）\n`)
    return
  }
  if (action === 'remove') {
    if (id === undefined) die('用法：dims remove <id>')
    if (BUILTIN_DIMENSION_IDS.includes(id)) {
      die(`${id} 是内置大类，不能删除（要给自己的分类腾位置，用 dims add 增加自定义大类）`)
    }
    if (!config.dimensions.includes(id)) die(`没有这个大类：${id}`)
    const owned = readJsonl(p('declarations.jsonl')).filter((record) => record?.dim === id)
    if (owned.length > 0) {
      die(`大类 ${id} 下还有 ${owned.length} 条条目，先迁移或删除：\n  profile dims move ${id} <目标大类>\n  profile forget --dim ${id}`)
    }
    config.dimensions = config.dimensions.filter((dim) => dim !== id)
    if (config.dimensionLabels !== undefined) delete config.dimensionLabels[id]
    saveConfig(config)
    rebuildQuietly()
    process.stdout.write(`已移除大类 ${id}\n`)
    return
  }
  if (action === 'reclassify') {
    // 老数据（旧维度名 / 迁移时被判偏的条目）按内容重新归一次大类。
    // --force 连「已是合法大类」的条目一起重判（人工判过就别加，会被规则覆盖）。
    const force = positional.includes('--force')
    const file = p('declarations.jsonl')
    const records = readJsonl(file)
    let changed = 0
    const next = records.map((record) => {
      if (!force && BUILTIN_DIMENSION_IDS.includes(record?.dim) && LEGACY_DIMENSION_MAP[record.dim] === undefined) {
        return record
      }
      const target = classifyLegacy(record)
      if (target === record.dim) return record
      changed += 1
      return { ...record, dim: target, previousDim: record.dim }
    })
    if (changed === 0) {
      process.stdout.write('没有需要重新归类的条目\n')
      return
    }
    try {
      copyFileSync(file, `${file}.bak-reclassify-${Date.now()}`)
    } catch {
      // 备份失败不阻止归类：宁可留旧维度也不让命令卡死
    }
    writeJsonl(file, next)
    appendJsonl(p('changelog.jsonl'), { at: nowIso(), kind: 'reclassify', changed })
    rebuildQuietly()
    process.stdout.write(`已重新归类 ${changed} 条（画像已刷新）\n`)
    return
  }
  die('用法：dims list | dims add <id> <标签> | dims remove <id> | dims reclassify')
}

function cmdSnapshots({ positional }) {
  const rows = listSnapshots(40)
  if (rows.length === 0) {
    process.stdout.write('还没有快照（删除/合并条目时会自动留一份）\n')
    return
  }
  process.stdout.write('删除前的自动快照（新的在前；profile restore --name <名字> 可回退）\n\n')
  for (const row of rows) {
    process.stdout.write(`  ${row.name}  ${String(row.count).padStart(3)} 条  ${row.bytes} 字节\n`)
  }
  const want = positional[0]
  if (typeof want === 'string' && want.length > 0) {
    process.stdout.write(`\n回退用法：profile restore --name ${want}\n`)
  }
}

/** 从快照恢复：整表替换声明（会再留一份 restore 快照，可反悔）。 */
function cmdRestore({ flags }) {
  const name = typeof flags.name === 'string' ? flags.name : ''
  if (!/^declarations-[\w.-]+\.jsonl$/.test(name)) die('用法：restore --name <snapshots 里的文件名>')
  const file = p('snapshots', name)
  if (!existsSync(file)) die(`没有这个快照：${name}`)
  const rows = readJsonl(file)
  if (rows.length === 0) die('该快照是空的，恢复它等于清空画像；如果确实要清空，用 reset --yes')
  snapshotDeclarations('restore')
  writeJsonl(p('declarations.jsonl'), rows)
  appendJsonl(p('changelog.jsonl'), { at: nowIso(), kind: 'restore', from: name, records: rows.length })
  rebuildQuietly()
  process.stdout.write(`已从 ${name} 恢复 ${rows.length} 条（画像已刷新）\n`)
}

function cmdStatus({ flags }) {
  const config = loadConfig()
  const profile = readJson(p('profile.json'), undefined)
  const declarations = readJsonl(p('declarations.jsonl')).length
  const observations = loadObservations(config)
  const pending = countPending()
  const summary = {
    home: HOME,
    enabled: config.enabled,
    mode: config.inject.mode,
    maxChars: config.inject.maxChars,
    topK: config.inject.topK,
    coreDimensions: config.inject.coreDimensions,
    strategy: config.conflicts.strategy,
    scope: activeScope({}, config).id,
    profile: profile === undefined
      ? 'missing'
      : { revision: profile.revision, status: profile.status, builtAt: profile.builtAt, items: profile.stats?.items ?? 0 },
    declarations,
    pending,
    turns: observations.length,
    lastObservation: observations.length > 0 ? observations[observations.length - 1].at : null,
    privacyMode: config.redaction.mode,
    injectChars: existsSync(p('inject.md')) ? readFileSync(p('inject.md'), 'utf8').length : 0,
    // 画像里记的声明数 vs 磁盘实际条数：不等就是「画像过期」
    stale: profile !== undefined && typeof profile.stats?.declarations === 'number'
      ? profile.stats.declarations !== declarations
      : false,
  }
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }
  process.stdout.write([
    `目录         ${summary.home}`,
    `默认叠加     ${summary.enabled ? `开（mode=${summary.mode}, maxChars=${summary.maxChars}, topK=${summary.topK}）` : '关'}`,
    `冲突策略     ${summary.strategy}`,
    `作用域       ${summary.scope}`,
    `画像         ${summary.profile === 'missing' ? '未生成' : `v${summary.profile.revision} · ${summary.profile.status} · ${summary.profile.items} 条 · ${summary.profile.builtAt}`}`,
    `声明型事实   ${summary.declarations} 条`,
    `待审候选     ${summary.pending} 条`,
    `运行观测     ${summary.turns} 轮（仅内部判断用，不进画像；最近 ${summary.lastObservation ?? '—'}）`,
    `注入正文     ${summary.injectChars} 字符`,
    ...(summary.stale ? ['一致性       画像已过期（声明数变了但没 build）→ 运行 build 刷新'] : []),
    `隐私模式     ${summary.privacyMode}`,
  ].join('\n') + '\n')
}

// 允许从命令行/面板写入的配置项；不在表里的一律拒绝（否则拼错的键会悄悄写进 config）
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
    die(`未知配置项：${dotted}（用 profile set --list 看可用项）`)
  }
  if (spec.type === 'boolean') {
    const v = String(rawValue).trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(v)) return true
    if (['false', '0', 'no', 'off'].includes(v)) return false
    die(`${dotted} 只接受 true / false（收到 ${JSON.stringify(rawValue)}）`)
  }
  if (spec.type === 'enum') {
    const v = String(rawValue).trim()
    if (!spec.values.includes(v)) die(`${dotted} 只能是 ${spec.values.join(' / ')}（收到 ${JSON.stringify(v)}）`)
    return v
  }
  if (spec.type === 'number') {
    const n = Number(String(rawValue).trim())
    if (!Number.isFinite(n)) die(`${dotted} 需要数字（收到 ${JSON.stringify(rawValue)}）`)
    if (spec.integer && !Number.isInteger(n)) die(`${dotted} 需要整数（收到 ${n}）`)
    if (n < spec.min || n > spec.max) die(`${dotted} 应在 ${spec.min}..${spec.max} 之间（收到 ${n}）`)
    return n
  }
  if (spec.type === 'dimensionList') {
    const text = String(rawValue).trim()
    let list = []
    if (text.startsWith('[')) {
      // 面板会发送 JSON 数组字符串；命令行更常用逗号分隔，两者都接受
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) list = parsed.map((item) => String(item).trim()).filter(Boolean)
      } catch {
        die(`${dotted} 需要维度列表（逗号分隔或 JSON 数组），收到 ${JSON.stringify(text)}`)
      }
    }
    if (list.length === 0) list = text.split(/[,\s]+/).filter(Boolean)
    if (list.length === 0) return []
    const unknown = list.filter((dim) => !config.dimensions.includes(dim))
    if (unknown.length > 0) die(`${dotted} 里有不存在的大类：${unknown.join(', ')}`)
    return list
  }
  if (spec.type === 'string') return String(rawValue)
  die(`配置项 ${dotted} 的类型未定义，先在 SET_SPEC 里补上`)
}

function cmdSet({ positional, flags }) {
  const [dotted, rawValue] = positional
  if (dotted === undefined || dotted === 'list' || dotted === '--list') {
    process.stdout.write('可写配置项（profile set <键> <值>）：\n\n')
    for (const [key, spec] of Object.entries(SET_SPEC)) {
      const range = spec.type === 'number'
        ? ` ${spec.min}..${spec.max}`
        : spec.type === 'enum' ? ` ${spec.values.join('|')}` : ''
      process.stdout.write(`  ${key.padEnd(34)} ${spec.type}${range}\n      ${spec.note ?? ''}\n`)
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
  if (flags.rebuild === true) {
    rebuildQuietly()
    process.stdout.write(`已更新 ${dotted} = ${JSON.stringify(value)}（画像已刷新）\n`)
    return
  }
  process.stdout.write(`已更新 ${dotted} = ${JSON.stringify(value)}（下次生成画像/下一轮对话时生效；想立刻应用加 --rebuild）\n`)
}

function cmdReset({ flags }) {
  if (flags.yes !== true) die('这会清空画像数据；确认请加 --yes')
  ensureDirs()
  const stamp = nowIso().replace(/[:.]/g, '-')
  const dir = p('archive', stamp)
  mkdirSync(dir, { recursive: true })
  for (const name of ['declarations.jsonl', 'profile.json', 'profile.md', 'inject.md', 'changelog.jsonl', 'pending.jsonl']) {
    if (existsSync(p(name))) renameSync(p(name), join(dir, name))
  }
  if (existsSync(p('observations'))) renameSync(p('observations'), join(dir, 'observations'))
  ensureDirs()
  writeFileSync(p('declarations.jsonl'), '', 'utf8')
  process.stdout.write(`已归档到 ${dir}\n`)
}

function cmdExport({ flags }) {
  const out = typeof flags.out === 'string' ? flags.out : p('export')
  mkdirSync(out, { recursive: true })
  for (const name of ['profile.json', 'profile.md', 'inject.md', 'declarations.jsonl', 'pending.jsonl', 'changelog.jsonl', 'config.json']) {
    if (existsSync(p(name))) writeFileSync(join(out, name), readFileSync(p(name)))
  }
  process.stdout.write(`已导出到 ${out}\n`)
}

// ---------------------------------------------------------------- 入口

const COMMANDS = {
  init: cmdInit,
  declare: cmdDeclare,
  observe: cmdObserve,
  build: cmdBuild,
  show: cmdShow,
  status: cmdStatus,
  panel: cmdPanel,
  review: cmdReview,
  forget: cmdForget,
  edit: cmdEdit,
  merge: cmdMerge,
  import: cmdImport,
  dims: cmdDims,
  snapshots: cmdSnapshots,
  restore: cmdRestore,
  set: cmdSet,
  reset: cmdReset,
  export: cmdExport,
}

// 改写型命令必须串行：它们都是「读全量 → 改几条 → 整表写回」，
// 并发时后写的一方会把前一方刚加的记录覆盖掉（这正是丢记录的元凶）。
// 追加型命令（declare/observe）也一并加锁：否则它可能恰好插在别人「读」和「写回」之间，
// 追加的那条会被整表写回抹掉——这正是实测丢 3 条声明的现场。
const MUTATING = new Set(['declare', 'observe', 'build', 'review', 'forget', 'edit', 'merge', 'import', 'dims', 'set', 'reset', 'restore'])

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional.shift()
  if (command === undefined || command === 'help' || flags.help === true) {
    process.stdout.write(`dsh-profile <命令>\n\n${Object.keys(COMMANDS).map((c) => `  ${c}`).join('\n')}\n\n详见 README.md\n`)
    return
  }
  const handler = COMMANDS[command]
  if (handler === undefined) die(`未知命令 ${command}`)
  if (MUTATING.has(command)) {
    withLock(() => handler({ positional, flags }))
    return
  }
  handler({ positional, flags })
}

main()
