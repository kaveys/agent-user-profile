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
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const HOME = process.env.DSH_USER_PROFILE_HOME || join(homedir(), '.dsh', 'user-profile')
const p = (...parts) => join(HOME, ...parts)

/** 单次进程内的配置告警（配置损坏被重建时非空）；只用于向用户交代，不写进数据。 */
let configWarnings = []

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

/**
 * 三类分区（流程第 3 步）：把十个大类折成 user_profile / user_preference / user_social_network。
 * 大类回答「记什么」，分区回答「这是他的哪一面」——面板、导出、以及将来按分区清空都用它。
 */
const PARTITIONS = [
  { id: 'user_profile', label: '基础身份', dims: ['identity', 'work', 'skills', 'goals', 'constraints'] },
  { id: 'user_preference', label: '偏好', dims: ['taste', 'communication', 'habits', 'interests'] },
  { id: 'user_social_network', label: '社交', dims: ['social'] },
]

function partitionOf(dim) {
  for (const p of PARTITIONS) {
    if (p.dims.includes(dim)) return p.id
  }
  // 自定义大类默认归「偏好」：用户自己加的多半就是偏好类
  return 'user_preference'
}
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
  schemaVersion: 5,
  // 默认叠加开关：true = 每次任务前注入画像
  enabled: true,
  inject: {
    // 'always' 默认叠加；'on-request' = 仅当用户在对话里要求时才注入（关闭默认叠加）
    mode: 'always',
    // 注入正文预算。0 = 不设上限（默认）：条目数是靠「有效性闸门」控制的，不是靠截断。
    // 设成正数则作为**软**预算：超出时按优先级截尾，并在注入块里写明还剩几条没放下。
    maxChars: 0,
    // 兼容旧配置；0 = 不限制（旧版默认 8 条会把「背景参考」段的条目直接切掉）
    topK: 0,
    // 这几个维度的条目一律视为「核心」：不受 topK 限制，优先进入注入块
    coreDimensions: ['constraints', 'identity'],
    // 个性化需求（风格、口味、默认选择、文案、推荐、界面）以这些维度为主要依据
    personalizeDimensions: ['taste', 'communication', 'habits', 'interests', 'goals'],
    // 是否在注入块里单列「个性化首选」段；关掉则退回「全部按权重排」的老样子
    priorityOnPersonalize: true,
    // 只带入和本轮相关的条目（流程第 5 步：记忆不自动扩散）；关掉则整份画像全带
    relevantOnly: true,
    relevanceFloor: 0.12,
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
  // 写入时脱敏（v15）：默认开启四类预设。mode 只说明来源，规则看 presets / patterns。
  redaction: { mode: 'preset', presets: ['phone', 'email', 'idcard', 'secret'], patterns: [] },
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
  /**
   * 备份（v15）：把导出包推到 WebDAV。
   * 默认关闭 —— 没人愿意在自己不知情的时候往远端写数据。
   * 密码永不进 config.json：只从环境变量（默认 DSH_PROFILE_WEBDAV_PASSWORD）
   * 或 ~/.dsh/user-profile/secrets.json（建议 chmod 600）读取。
   */
  backup: {
    webdav: {
      enabled: false,
      url: '',
      username: '',
      passwordEnv: 'DSH_PROFILE_WEBDAV_PASSWORD',
      remoteDir: 'dsh-user-profile',
      autoUploadOnBuild: false,
      keepLast: 10,
      timeoutMs: 20000,
    },
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

/**
 * 同步睡一小段。
 * 旧实现是 `while (Date.now() < until) {}` —— 空转，最坏 200 次 × 50ms = 10 秒占满一个核，
 * 在笔记本上烫手、在 CI 里抢 CPU。Atomics.wait 是真正的阻塞等待，不烧 CPU。
 */
const sleepCell = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms)
}

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
      // 时间戳必须在「创建成功」的同一步写进去：
      // 先 openSync('wx') 再 writeFileSync 中间有一个空档，别的进程会把空文件读成 0、
      // 判成年老失锁并删掉，于是两个进程同时持锁（实测就是这么丢的数据）。
      const fd = openSync(lock, 'wx')
      writeSync(fd, String(Date.now()))
      closeSync(fd)
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
      // 陈旧锁：持有者崩在中间，超过 60s 视为失效。
      // 读不到数字（空文件/半截写入）一律按「刚创建」处理 —— 宁可多等 10 秒，
      // 也不能把别人正持有的锁删掉：那等于没有锁。
      try {
        const stamp = Number(readFileSync(lock, 'utf8'))
        const age = Date.now() - stamp
        if (Number.isFinite(stamp) && stamp > 0 && age > 60000) unlinkSync(lock)
      } catch {
        // 读不到就继续等
      }
      sleepSync(waitMs)
    }
  }
  die(`另一个 profile 进程正持有锁（${lock}）；等它结束或删除该文件后重试`)
}

function writeJson(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 把正文压成一个稳定的短指纹，用来当「没显式给 key」时的默认 key。
 * 目的：同一句话反复记 → 命中同一条（更新 + 留历史）；
 *      不同的话 → 各自成条。默认 key 取维度名会把后一条顶掉，等于静默丢数据。
 */
function factKey(text) {
  let hash = 5381
  const source = String(text ?? '').replace(/\s+/g, '')
  for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/**
 * - 整行 `## 标题` 会伪造出新的分段（注入块靠段标题决定「哪些是红线」）；
 * - `<!--dsh-user-profile-->` 是插件的去重指纹，出现在正文里会让下一轮误判「已经注入过」；
 * - 换行会把一条变成多条（列表项里塞进伪造的条目）。
 * 只在渲染时消毒，磁盘上保留原话，避免改写用户数据。
 */
function safeText(text) {
  return String(text ?? '')
    .replace(/<!--\s*dsh-user-profile\s*-->/gi, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/【插件规定】/g, '［插件规定］')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 只有「我们自己写、且会被整表重写」的文件才可以就地修复；
 * observations/ 是只追加的运行日志，坏了也不该在读取时改写它。
 */
const REPAIRABLE_JSONL = new Set(['declarations.jsonl', 'pending.jsonl'])

/**
 * 读 JSONL。
 *
 * 旧实现遇到坏行直接 continue —— 一条被编辑器改坏、或写到一半断电的记录，
 * 会从画像里无声消失（这正是 CONTRIBUTING 里禁止的「静默丢数据」）。
 * 现在：坏行进 <file>.bad-<日期> 隔离文件，好行照常使用；如果这个文件是我们
 * 自己维护的（declarations / pending），顺手把好行原子写回，使坏行不再反复出现。
 * 隔离失败也绝不中断读取 —— 读不出来比少一条更糟。
 */
/** 一条画像必须是「关于用户的一句可复用陈述」；不符合的一律拒绝入库，不留脏数据。 */
const FACT_MIN_LEN = 3
const FACT_MAX_LEN = 400
const STRUCTURE_BREAKERS = /(<!--|-->|^\s{0,3}#{1,6}\s|【插件规定】)/m
const TASK_SCOPED_HINTS = /(本次|这一轮|这轮|当前任务|刚才那|临时|待会|这个文件|这个仓库|该文件)/

/**
 * 有效性闸门（v15）。
 *
 * 用户的要求是「条数不设上限，但数据必须绝对有效」。所以这里不做数量上限，
 * 而是每次写入都过一遍：结构上能不能安全渲染、是不是关于用户本人的跨任务陈述、
 * 维度与置信度是否合法。拒绝时把**原因**逐条说出来，并留 `--force` 逃生门。
 */
function validateEntry(record, config) {
  const reasons = []
  const fact = typeof record?.fact === 'string' ? record.fact.trim() : ''
  if (fact.length < FACT_MIN_LEN) reasons.push(`内容太短（${fact.length} 字，至少要 ${FACT_MIN_LEN} 字）`)
  if (fact.length > FACT_MAX_LEN) reasons.push(`内容过长（${fact.length} 字，上限 ${FACT_MAX_LEN}）`)
  if (STRUCTURE_BREAKERS.test(fact)) reasons.push('内容里有标题标记 / HTML 注释 / 伪造的规定段，会被渲染成别的结构')
  if (/[\r\n]/.test(fact)) reasons.push('内容含换行，注入时会变成多条')
  // 高风险隐私（证件号/银行卡/密码/精确住址）：不是"打码后记录"，而是根本不记。
  const privacy = blockedPrivacy(fact)
  if (privacy.length > 0) reasons.push(`内容含高风险隐私（${privacy.join('、')}），不该入库`)
  if (typeof record?.dim !== 'string' || !Array.isArray(config?.dimensions) || !config.dimensions.includes(record.dim)) {
    reasons.push(`维度不合法（${record?.dim ?? '空'}）`)
  }
  const confidence = Number(record?.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    reasons.push(`置信度不在 0..1（${record?.confidence ?? '空'}）`)
  }
  if (typeof record?.key !== 'string' || record.key.trim().length === 0) reasons.push('缺少 key')
  // 「本次任务的细节」只对 global 条目算问题：project 条目的存在意义就是项目内有效，
  // 拿全局门槛去卡它，等于把 project 这一级直接废掉。
  const scope = record?.scope === 'project' ? 'project' : 'global'
  if (scope === 'global' && TASK_SCOPED_HINTS.test(fact)) {
    reasons.push('这条读起来是本次任务的细节（含「本次 / 这一轮 / 临时」等词），换个任务就不成立了；确实只在当前项目有效就加 --scope project')
  }
  return { ok: reasons.length === 0, reasons }
}

function assertValid(record, config, flags = {}) {
  const { ok, reasons } = validateEntry(record, config)
  if (ok) return
  if (flags.force === true) {
    process.stderr.write(`dsh-profile: 已用 --force 强行写入 ${reasons.length} 项问题：${reasons.join('；')}\n`)
    return
  }
  die(`这条不适合进画像（加 --force 可强行写入）：\n  - ${reasons.join('\n  - ')}`)
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  const bad = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      bad.push(trimmed)
    }
  }
  if (bad.length > 0) {
    const name = basename(file)
    if (REPAIRABLE_JSONL.has(name)) {
      const dump = `${file}.bad-${new Date().toISOString().slice(0, 10)}`
      try {
        appendFileSync(dump, `${bad.join('\n')}\n`, 'utf8')
        writeFileAtomic(file, out.map((r) => JSON.stringify(r)).join('\n') + (out.length > 0 ? '\n' : ''))
        configWarnings.push(
          `${name} 有 ${bad.length} 行损坏，已隔离到 ${basename(dump)}（其余 ${out.length} 条照常使用）`,
        )
      } catch {
        configWarnings.push(`${name} 有 ${bad.length} 行损坏，且隔离失败（不影响读取到的 ${out.length} 条）`)
      }
    } else {
      configWarnings.push(`${name} 有 ${bad.length} 行损坏，已跳过（该文件只读，未改写）`)
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
  configWarnings = []
  let raw = {}
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text)
      } catch (error) {
        // 配置坏了就没人守得住后面的写操作：先留证据，再用默认值重建一份，
        // 否则每次命令都只能吃默认值，且写回时会把损坏内容彻底抹掉。
        const backup = `${file}.corrupt-${Date.now()}`
        try { copyFileSync(file, backup) } catch { /* 备份失败也要能继续 */ }
        raw = {}
        configWarnings.push(`配置文件损坏（${error.message}），已备份为 ${basename(backup)}，并按默认配置重建`)
      }
    }
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    // 展开 raw 会把旧版本号带回来，所以最后显式钉成当前版本
    schemaVersion: DEFAULT_CONFIG.schemaVersion,
    inject: { ...DEFAULT_CONFIG.inject, ...(raw.inject ?? {}) },
    capture: { ...DEFAULT_CONFIG.capture, ...(raw.capture ?? {}) },
    build: { ...DEFAULT_CONFIG.build, ...(raw.build ?? {}) },
    redaction: {
      ...DEFAULT_CONFIG.redaction,
      ...(raw.redaction ?? {}),
      // 老配置里没有 presets：给上默认预设，否则「脱敏」这个词等于没实现
      presets: Array.isArray(raw?.redaction?.presets)
        ? raw.redaction.presets
        : DEFAULT_CONFIG.redaction.presets,
      patterns: Array.isArray(raw?.redaction?.patterns) ? raw.redaction.patterns : [],
    },
    conflicts: { ...DEFAULT_CONFIG.conflicts, ...(raw.conflicts ?? {}) },
    scope: { ...DEFAULT_CONFIG.scope, ...(raw.scope ?? {}) },
    backup: {
      ...DEFAULT_CONFIG.backup,
      ...(raw.backup ?? {}),
      webdav: { ...DEFAULT_CONFIG.backup.webdav, ...(raw?.backup?.webdav ?? {}) },
    },
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
  // v5：「条数不设上限，质量靠闸门」。老配置里那两个数是我们自己的旧默认值，
  // 不是用户选的 —— 不清掉它们，新默认值永远不生效，用户会以为改动没上线。
  if (rawVersion < 5) {
    if (Number(merged.inject?.maxChars) === 1600) merged.inject.maxChars = 0
    if (Number(merged.inject?.topK) === 8) merged.inject.topK = 0
    if (merged.redaction?.mode === 'unknown') {
      merged.redaction.mode = 'preset'
      if (!Array.isArray(merged.redaction.presets) || merged.redaction.presets.length === 0) {
        merged.redaction.presets = [...DEFAULT_CONFIG.redaction.presets]
      }
    }
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
/**
 * 内置脱敏预设（v15）。
 *
 * 之前 redaction.patterns 是空数组——字段摆在那儿却什么都没做，等于「说好了要脱敏」。
 * 现在默认开启四类最常被顺手粘进对话的东西；命中就替换成 ⟨手机号⟩ 这样的占位符，
 * 并在回执里告诉用户「已脱敏 N 处」，而不是悄悄改掉。
 *
 * 注意：这是**写入时**的脱敏，只管新记录；已有记录用 `profile redact --apply` 批量清洗。
 */
const REDACTION_PRESETS = {
  phone: { label: '手机号', pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', replace: '⟨手机号⟩' },
  email: { label: '邮箱', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', replace: '⟨邮箱⟩' },
  idcard: { label: '证件号', pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', replace: '⟨证件号⟩' },
  secret: {
    label: '密钥',
    pattern: '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})',
    replace: '⟨密钥⟩',
  },
}

/**
 * 高风险隐私：命中一律拦截，不入库（打码也不算——记下"他有身份证号"本身就没价值）。
 * 与上面四个 preset 的区别：手机号/邮箱打码后仍有画像价值（联系方式类型），证件号/银行卡/密码只该是空气。
 */
const BLOCK_PATTERNS = [
  { label: '证件号', pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)' },
  { label: '银行卡号', pattern: '(?<!\\d)(?:\\d[ -]?){16,19}(?!\\d)' },
  { label: '密码/口令', pattern: '(密码|口令|password|passwd)\\s*(是|为|:|：|=)\\s*\\S{4,}' },
  { label: '精确住址', pattern: '(?<![\\d\\w])\\d{1,3}\\s*号楼?\\s*\\d{1,4}\\s*(室|号房|单元)' },
]

/** 返回命中的高风险隐私类别（空数组=可以入库）。 */
function blockedPrivacy(text) {
  if (typeof text !== 'string' || !text) return []
  const hits = []
  for (const rule of BLOCK_PATTERNS) {
    if (new RegExp(rule.pattern).test(text)) hits.push(rule.label)
  }
  return hits
}


/** 逐条正则替换；返回换了多少处（0 表示这条内容是干净的）。 */
function redactWithCount(text, config) {
  if (typeof text !== 'string') return { text: '', hits: 0 }
  let out = text
  let hits = 0
  const presets = Array.isArray(config?.redaction?.presets) ? config.redaction.presets : []
  for (const id of presets) {
    const preset = REDACTION_PRESETS[id]
    if (!preset) continue
    try {
      out = out.replace(new RegExp(preset.pattern, 'g'), () => {
        hits += 1
        return preset.replace
      })
    } catch {
      // 预设写错不影响采集
    }
  }
  const patterns = Array.isArray(config?.redaction?.patterns) ? config.redaction.patterns : []
  for (const rule of patterns) {
    if (typeof rule?.pattern !== 'string') continue
    try {
      out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), () => {
        hits += 1
        return rule.replace ?? '[已脱敏]'
      })
    } catch {
      // 规则写错不影响采集
    }
  }
  return { text: out, hits }
}

function redact(text, config) {
  return redactWithCount(text, config).text
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

/** 统一排序：核心优先 → 权重降序 → 最近出现降序 → 文本更长者优先。面板与注入都用它，保证两处一致。 */
function rankItem(a, b) {
  // 核心（红线/硬要求）在最前面：注入块里它单独占第一段，面板也应该照着排，
  // 否则「按优先级排列」这句话在面板上是假的。
  const ca = a?.core === true
  const cb = b?.core === true
  if (ca !== cb) return ca ? -1 : 1
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
  const rawFact = typeof flags.fact === 'string' ? flags.fact.trim() : ''
  if (rawFact.length === 0) die('缺少 --fact "要记录的内容"')
  // 一条画像应当是一句可复用的话。超长正文八成是把整段对话塞进来了：
  // 截断并明确告知，比让它撑爆注入预算或静默丢进待审更诚实。
  const MAX_FACT = 400
  const truncated = rawFact.length > MAX_FACT
  const fact = truncated ? `${rawFact.slice(0, MAX_FACT - 1)}…` : rawFact
  const config = loadConfig()
  if (!config.dimensions.includes(dim)) {
    die(`未知维度 ${dim}；可用：${config.dimensions.join(', ')}`)
  }
  const source = flags.source === 'model' ? 'model' : 'user'
  const confidence = Number.isFinite(Number(flags.confidence)) ? Number(flags.confidence) : (source === 'user' ? 1 : 0.6)
  const scopeKind = typeof flags.scope === 'string' && flags.scope.length > 0 ? flags.scope : 'global'
  // 高风险隐私一律拦截（流程第 1 步）：证件号 / 银行卡 / 密码 / 精确住址不打码入库，
  // 因为「记着他有身份证号」这件事本身就没有画像价值，留着只是风险。
  if (flags.force !== true) {
    const blocked = blockedPrivacy(fact)
    if (blocked.length > 0) {
      die(`已拦截：内容含${blocked.join('、')}，不进记忆库（确需记录请显式加 --force，或改写成不含该信息的结论）`)
    }
  }
  // 写入时脱敏：命中手机号/邮箱/证件号/密钥就替换成占位符，并把命中次数写进回执。
  const cleaned = redactWithCount(fact, config)
  const record = {
    id: newId('dcl'),
    at: nowIso(),
    dim,
    // 没给 key 时用「内容指纹」当 key：同一句话说第二遍会更新那一条，
    // 不同的话各自成条。早前默认 key=维度名，同一大类里第二条会把第一条顶掉。
    key: typeof flags.key === 'string' && flags.key.length > 0 ? flags.key : `${dim}.${factKey(fact)}`,
    fact: cleaned.text,
    source,
    confidence: Math.min(1, Math.max(0, confidence)),
    core: flags.core === true,
    scope: scopeKind,
    scopeId: scopeKind === 'global' ? undefined : activeScope(flags, config).id,
    session: typeof flags.session === 'string' ? flags.session : undefined,
    // 溯源（v15）：记下「从哪句话、哪一轮来的」。将来出问题能翻回原话，
    // 而不是只能整条删掉。excerpt 由调用方给（host 插件传当轮用户首句）。
    provenance: {
      kind: source === 'model' ? 'model' : 'user',
      at: nowIso(),
      session: typeof flags.session === 'string' ? flags.session : undefined,
      turn: Number.isFinite(Number(flags.turn)) ? Number(flags.turn) : undefined,
      excerpt: typeof flags.excerpt === 'string' ? flags.excerpt.slice(0, 80) : undefined,
    },
  }
  assertValid(record, config, flags)
  const clampNote = truncated ? `\n（原文 ${rawFact.length} 字，超过 ${MAX_FACT} 字上限，已截断后记录）` : ''
  const redactNote = cleaned.hits > 0 ? `\n（已脱敏 ${cleaned.hits} 处敏感内容）` : ''

  // 同一句话再说一遍 = 刷新那一条，不是再插一条。
  // （早前只靠 build 阶段的相似度合并来兜底，结果 declarations.jsonl 越滚越长、
  //  历史里堆着一串同义条目；这里在写入端就把它钉住。）
  const targetFile = flags.pending === true ? p('pending.jsonl') : p('declarations.jsonl')
  const existing = readJsonl(targetFile).find((row) => (
    row?.dim === record.dim
    && row?.key === record.key
    && (row?.scope ?? 'global') === (record.scope ?? 'global')
    && (row?.scopeId ?? '') === (record.scopeId ?? '')
    && row?.fact === record.fact
  ))
  if (existing !== undefined) {
    const rows = readJsonl(targetFile).map((row) => (row === existing || row?.id === existing.id
      ? { ...row, at: record.at, editedAt: record.at, confidence: record.confidence, core: row.core === true || record.core, provenance: record.provenance }
      : row))
    writeJsonl(targetFile, rows)
    if (flags.pending !== true) rebuildQuietly()
    process.stdout.write(`已更新（原来是同一条）[${record.dim}] ${record.fact}${clampNote}${redactNote}\n${flags.pending === true ? '' : '（画像已刷新）\n'}`)
    return
  }

  if (flags.pending === true) {
    appendJsonl(p('pending.jsonl'), record)
    process.stdout.write(`已加入待审候选 [${dim}] ${record.fact}${clampNote}${redactNote}\n（确认：profile review --accept ${record.id}；或 review --accept all）\n`)
    return
  }
  appendJsonl(p('declarations.jsonl'), record)
  rebuildQuietly()
  process.stdout.write(`已记录 [${dim}] ${record.fact}${clampNote}${redactNote}\n（画像已刷新）\n`)}

// ---------------------------------------------------------------- ingest（v24）
// 从别的 AI 搬回画像：用户去问「你掌握了关于我的什么信息」，把答复整段贴进来。
// 这里做三件事，全部是确定性规则，报告里逐条能看到依据：
//   1. 切分：按行 / 列表符号 / 句号拆成一条条陈述，扔掉寒暄与表头；
//   2. 归类：按「大类优先级表」匹配关键词，第一条命中的大类胜出（可解释、可复现）；
//   3. 定权：0.55 起步，硬性要求 +0.15、稳定特征 +0.10、同批佐证 +0.05、含糊措辞 −0.12，
//      夹在 0.35~0.85；constraints 且是硬性要求的直接给 0.85 并标核心。
// 二手来源永远拿不到 1.0：话是别的 AI 转述的，不是用户亲口确认的。
const INGEST_PRIORITY = [
  // 顺序即优先级：一句话同时命中多个大类时，取最靠前的那个。
  // communication 排在 constraints 前，是为了让「回答简短点，不要废话」落到表达习惯而不是红线；
  // goals 排在 work 前，是为了让「计划明年上线产品」落到目标而不是职业。
  ['communication', /(回答|回复|语气|措辞|表达|沟通|先给结论|给结论|表格|清单|简短|详细一点|不要废话)/],
  ['constraints', /(必须|不要|不能|禁止|一律|绝对|绝不|不许|务必|只能|红线|底线|不希望|别让|别再)/],
  ['taste', /(审美|风格|口味|配色|视觉|界面|设计|品牌|极简|简洁|好看|排版)/],
  ['habits', /(习惯|每天|每周|总是|通常|一般会|作息|早上|晚上|节奏|小步|备份|整理)/],
  ['goals', /(目标|计划|打算|正在学|准备|冲刺|竞赛|变现|上线|明年|长期|梦想)/],
  ['skills', /(熟悉|掌握|精通|会用|擅长|熟练|技术栈|框架|工具链|Python|JavaScript|Node\.?js|C\s*语言|Java|Go|Rust|SQL)/i],
  ['work', /(在职|工作|职业|岗位|公司|团队|项目|实习|工程师|创业)/],
  ['identity', /(我是|我叫|我在|我住|来自|岁|本科|硕士|博士|大学|学校|专业|母语|时区|生日)/],
  ['interests', /(爱好|兴趣|喜欢|游戏|电影|音乐|追剧|运动|健身|摄影|收藏|看球)/],
  ['social', /(同事|同学|朋友|合作|协作|分享|公开|社群|发布)/],
]
const INGEST_BOILERPLATE = /^[（(【\[]?(以下|根据|据我|我了解|我掌握|目前|暂时|暂无|没有(相关|更多)?信息|无法(确认|判断)|作为\s*AI|以上|总共|总结)/
const INGEST_HEDGE = /(可能|也许|似乎|大概|据说|推测|或许|不一定)/
const INGEST_RULE = /(必须|不要|不能|禁止|一律|绝对|绝不|不许|务必|只能|不希望|别让|别再)/
const INGEST_STABLE = /(我是|我在|我习惯|我喜欢|我长期|我从事|我的|我一直)/

function classifyFact(text) {
  for (const [dim, pattern] of INGEST_PRIORITY) {
    const hit = text.match(pattern)
    if (hit !== null) return { dim, keyword: hit[0] }
  }
  return null
}

// 别的 AI 习惯用第二人称（「你是一名本科生」），画像里统一成「用户…」：
// 注入 prompt 时主语错位会让模型把自己当成被描述对象。
const normalizeVoice = (text) => String(text ?? '')
  .replace(/你的/g, '自己的')
  .replace(/^您/u, '用户')
  .replace(/^你(?![们的])/u, '用户')

function splitIngestCandidates(text) {
  const out = []
  const push = (raw) => {
    const line = String(raw ?? '')
      .replace(/\r/g, '')
      .replace(/^\s*(?:[-*•·–]|\d+[.)、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.])\s*/, '')
      .replace(/\*\*/g, '')
      .trim()
    if (line.length < 4 || line.length > 400) return
    if (line.startsWith('#')) return
    if (/^[|\-:\s]+$/.test(line)) return
    if (INGEST_BOILERPLATE.test(line)) return
    out.push(normalizeVoice(line))
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const walk = (node) => {
        if (typeof node === 'string') { node.split('\n').forEach(push); return }
        if (Array.isArray(node)) { node.forEach(walk); return }
        if (node !== null && typeof node === 'object') Object.values(node).forEach(walk)
      }
      walk(JSON.parse(trimmed))
      return out
    } catch { /* 不是合法 JSON，退回纯文本处理 */ }
  }
  for (const line of trimmed.split('\n')) {
    // 别的 AI 常把一段话写成一行，按中文句读再切一刀
    if (line.length > 120) line.split(/(?<=[。！？；])/).forEach(push)
    else push(line)
  }
  // 一句话里塞了两件事（「习惯晚上工作，通常先给结论」）：按逗号切开后若分别归到不同大类，
  // 就拆成两条 —— 否则整句只会落进优先级最高的那一类，另一半信息丢掉。
  const refined = []
  for (const line of out) {
    const parts = line.split(/[，,；;]/).map((part) => part.trim()).filter((part) => part.length >= 6)
    if (line.length >= 18 && parts.length >= 2) {
      const dims = parts.map((part) => classifyFact(part)?.dim).filter(Boolean)
      if (new Set(dims).size >= 2) {
        // 拆出来的后半段常常没有主语、还带个连接词（「也不能删自己的数据」）：
        // 去掉连接词并补上「用户」，否则单独看像半句话。
        parts.forEach((part) => {
          const body = part.replace(/^(也|还|并且|而且|同时|另外|但|但是|不过|却)/u, '').trim()
          const withSubject = /^(用户|我)/u.test(body) ? body : `用户${body}`
          if (withSubject.length >= 4) refined.push(withSubject)
        })
        continue
      }
    }
    refined.push(line)
  }
  return refined
}

function ingestWeight(text, dim, corroboration) {
  let weight = 0.55
  const reasons = []
  const rule = INGEST_RULE.test(text)
  if (rule) { weight += 0.15; reasons.push('硬性要求 +0.15') }
  if (INGEST_STABLE.test(text)) { weight += 0.1; reasons.push('稳定特征 +0.10') }
  if (corroboration > 1) { weight += 0.05; reasons.push(`同批佐证 ×${corroboration} +0.05`) }
  if (INGEST_HEDGE.test(text)) { weight -= 0.12; reasons.push('措辞含糊 −0.12') }
  if (dim === 'constraints' && rule) weight = Math.max(weight, 0.85)
  weight = Math.min(0.85, Math.max(0.35, Number(weight.toFixed(2))))
  return { weight, reasons, core: dim === 'constraints' && rule }
}

function cmdIngest({ flags }) {
  const config = loadConfig()
  const sourceLabel = typeof flags.source === 'string' && flags.source.trim().length > 0
    ? flags.source.trim()
    : 'other-ai'
  let text = ''
  if (typeof flags.file === 'string') {
    if (!existsSync(flags.file)) die(`读不到文件：${flags.file}`)
    text = readFileSync(flags.file, 'utf8')
  } else if (typeof flags.text === 'string') {
    text = flags.text
  } else {
    die('缺少输入：--file <path>（把别的 AI 的答复另存为 txt）或 --text "整段答复"')
  }
  const candidates = splitIngestCandidates(text)
  if (candidates.length === 0) {
    die('没识别到可用的陈述：至少要有一行像「我是……」「我习惯……」「不要……」这样的话')
  }
  const existing = readJsonl(p('declarations.jsonl'))
  const accepted = []
  const skipped = { privacy: [], unclassified: [], session: [], duplicate: [], known: [] }
  const seen = new Set()
  for (const raw of candidates) {
    if (blockedPrivacy(raw).length > 0) { skipped.privacy.push(raw); continue }
    const cleaned = redactWithCount(raw, config)
    const fact = cleaned.text.slice(0, 400)
    if (TASK_SCOPED_HINTS.test(fact)) { skipped.session.push(fact); continue }
    const cls = classifyFact(fact)
    if (cls === null) { skipped.unclassified.push(fact); continue }
    // 已经有一条意思相近的 → 复用它的 key，导入时会并进那一条而不是再加一条同义条目
    const near = existing.filter((row) => row?.dim === cls.dim && similarity(row?.fact ?? '', fact) >= 0.45)
    const key = near.length > 0 && typeof near[0]?.key === 'string' ? near[0].key : `${cls.dim}.${factKey(fact)}`
    const signature = `${cls.dim}|${key}|${normText(fact)}`
    if (seen.has(signature)) { skipped.duplicate.push(fact); continue }
    seen.add(signature)
    if (existing.some((row) => row?.dim === cls.dim && similarity(row?.fact ?? '', fact) >= 0.75)) {
      skipped.known.push(fact)
      continue
    }
    accepted.push({ dim: cls.dim, key, fact, keyword: cls.keyword, redactions: cleaned.hits })
  }
  // 先统计同批佐证次数，再统一算权重 —— 结果与处理顺序无关
  const buckets = new Map()
  for (const item of accepted) {
    const bucket = `${item.dim}|${item.key}`
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  for (const item of accepted) {
    const scored = ingestWeight(item.fact, item.dim, buckets.get(`${item.dim}|${item.key}`) ?? 1)
    item.weight = scored.weight
    item.reasons = scored.reasons
    item.core = scored.core
  }
  const groups = new Map()
  for (const item of accepted) {
    if (!groups.has(item.dim)) groups.set(item.dim, [])
    groups.get(item.dim).push(item)
  }
  const report = [`来源：${sourceLabel}　候选 ${candidates.length} 条 → 可写入 ${accepted.length} 条`]
  for (const [dim, items] of groups) {
    report.push(`\n## ${DIMENSION_LABELS[dim] ?? dim}（${items.length} 条）`)
    for (const item of items) {
      const marks = [item.core ? '核心' : '', item.redactions > 0 ? `已脱敏 ${item.redactions} 处` : '']
        .filter(Boolean).join(' · ')
      report.push(`- [${item.weight.toFixed(2)}] ${item.fact}${marks.length > 0 ? `（${marks}）` : ''}`)
      const why = [...item.reasons, `命中「${item.keyword}」`].join('，')
      report.push(`    依据：${why}`)
    }
  }
  const skipLines = []
  if (skipped.known.length > 0) skipLines.push(`already:${skipped.known.length}`)
  const describe = (label, list) => {
    if (list.length === 0) return
    const head = list.slice(0, 2).map((line) => line.length > 28 ? `${line.slice(0, 28)}…` : line).join('／')
    report.push(`- ${label} ${list.length} 条：${head}${list.length > 2 ? ' 等' : ''}`)
  }
  if (skipLines.length > 0 || skipped.privacy.length + skipped.unclassified.length + skipped.session.length + skipped.duplicate.length + skipped.known.length > 0) {
    report.push('\n## 跳过的条目')
    describe('画像里已有（相似度 ≥75%）', skipped.known)
    describe('疑似隐私，不收录', skipped.privacy)
    describe('本次任务细节，不收录', skipped.session)
    describe('同批重复', skipped.duplicate)
    describe('无法归类', skipped.unclassified)
  }
  const plan = report.join('\n')
  if (flags.apply !== true) {
    process.stdout.write(`${plan}\n\n（预览：确认无误后加 --apply 才会写进 declarations.jsonl）\n`)
    return
  }
  if (accepted.length === 0) {
    process.stdout.write(`${plan}\n\n没有需要写入的条目。\n`)
    return
  }
  snapshotDeclarations('ingest')
  const at = nowIso()
  for (const item of accepted) {
    appendJsonl(p('declarations.jsonl'), {
      id: newId('dcl'),
      at,
      dim: item.dim,
      key: item.key,
      fact: item.fact,
      source: 'model',
      confidence: item.weight,
      core: item.core === true,
      scope: 'global',
      provenance: {
        kind: 'import',
        at,
        source: sourceLabel,
        excerpt: item.fact.slice(0, 80),
      },
    })
  }
  rebuildQuietly()
  process.stdout.write(`${plan}\n\n已写入 ${accepted.length} 条（来源：${sourceLabel}；画像已刷新）\n`)
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
      // 溯源：面板与 show 用它回答「这条是从哪来的」
      provenance: record.provenance,
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
      lines.push(`- [${core}${tag} ${round(item.weight ?? 0, 2)}${frozen}${scope}] ${safeText(item.text)}`)
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
  // maxChars <= 0 表示不设上限：条目数量由「有效性闸门」把住，而不是靠截断。
  const limit = Number.isFinite(config.inject?.maxChars) && config.inject.maxChars > 0
    ? config.inject.maxChars
    : 0
  // topK 只对「背景参考」段生效；0 = 不限（旧默认 8 会截掉背景段，等于悄悄少给信息）
  const restK = Number.isFinite(config.inject?.topK) && config.inject.topK > 0
    ? config.inject.topK
    : 0
  const prioritize = config.inject?.priorityOnPersonalize !== false
  const personalizeDims = prioritize && Array.isArray(config.inject?.personalizeDimensions)
    ? config.inject.personalizeDimensions
    : (prioritize ? DEFAULT_CONFIG.inject.personalizeDimensions : [])

  const all = flatten(profile, config)
  const redline = all.filter((item) => item.core)
  const personalize = all.filter((item) => !item.core && personalizeDims.includes(item.dim))
  const restAll = all.filter((item) => !item.core && !personalizeDims.includes(item.dim))
  const rest = restK > 0 ? restAll.slice(0, restK) : restAll
  const restCutByK = restAll.length - rest.length

  const lineOf = (item) => {
    const kind = item.kind === 'declared' ? '已确认' : '我的观察'
    const frozen = item.frozen === true ? ' ·未决' : ''
    const scope = item.scope && item.scope !== 'global' ? ` ·${item.scope}` : ''
    return `- [${item.dimLabel} ${round(item.weight ?? 0, 2)}${frozen}${scope}·${kind}] ${safeText(item.text)}`
  }

  // 「本次带入」按**实际写进正文**的条数算（最后回填），不能把被预算裁掉的也数进去。
  // 这里只放「数据」：版本、时间、条数。使用规则（谁优先、什么时候当主要依据）
  // 是插件内部规定，写在 index.js 的 PLUGIN_POLICY 里，不落进画像文件，
  // 也不随画像被编辑/删除而改变。
  const head = [
    `# 用户画像 v${profile.revision}`,
    `> 生成于 ${profile.builtAt} · 共 ${profile.stats?.items ?? all.length} 条，本次带入 0 条`,
    '',
  ]

  const body = [...head]
  let used = head.join('\n').length

  /**
   * 逐段写正文。
   *
   * 旧实现给红线 40%、给个性化 75% —— 结果红线（规定里最优先的那一段）反而先被裁，
   * 而个性化段不受 topK 约束、可以一路挤到 75%，跟「红线 > 个性化」正好相反。
   * 现在三段共用一个绝对预算，先写的先占：红线永远优先，个性化次之，背景参考最后。
   * limit === 0 时不裁任何东西。
   */
  const pushSection = (title, items, noteWhenCut) => {
    if (items.length === 0) return
    const header = `${title}`
    body.push(header)
    used += header.length + 1
    let cut = 0
    for (const item of items) {
      const line = lineOf(item)
      if (limit > 0 && used + line.length + 1 > limit) {
        cut += 1
        continue
      }
      body.push(line)
      used += line.length + 1
    }
    if (cut > 0 && noteWhenCut !== undefined) body.push(noteWhenCut(cut))
    body.push('')
  }

  pushSection('## 一、红线与硬要求', redline, (cut) =>
    `（红线还有 ${cut} 条超出预算没放下：调大 inject.maxChars，或把 inject.maxChars 设为 0）`)
  pushSection('## 二、个性化首选', personalize, (cut) =>
    `（个性化条目还有 ${cut} 条超出预算没放下：调大 inject.maxChars，或把 inject.maxChars 设为 0）`)
  pushSection('## 三、背景参考', rest, (cut) =>
    `（背景参考还有 ${cut} 条超出预算没放下：调大 inject.maxChars，或把 inject.maxChars 设为 0）`)

  if (restCutByK > 0) {
    body.push(`（另有 ${restCutByK} 条背景参考被 inject.topK=${restK} 限制在外；设 0 可全部带入）`)
  }
  if (profile.stats.pending > 0) {
    body.push(`（有 ${profile.stats.pending} 条待审候选未进画像）`)
  }
  // 回填真实条数：只有真的写进正文的才算「带入」
  const written = body.filter((line) => line.startsWith('- [')).length
  body[1] = body[1].replace('本次带入 0 条', `本次带入 ${written} 条`)
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

/**
 * ---------------------------------------------------------------- 解释与体检（v20）
 * 为什么要有 explain：画像是个黑箱时，用户只会问「凭什么这句进了我的画像」。
 * 这里把「哪些条目会因为本轮这句话被带进来、哪些被相关性挡掉、为什么」摊开。
 */

/** 与 index.js 的 bigrams 保持同一算法（两处必须一起改，测试会对齐）。 */
function bigramsOf(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const out = new Set()
  for (const token of tokens) {
    if (token.length === 1) out.add(token)
    for (let i = 0; i + 1 < token.length; i += 1) out.add(token.slice(i, i + 2))
  }
  return out
}

/** 一条条目和查询的相关性：命中二元组数 / 条目二元组总数（0..1）。 */
// 相关度 = 命中的查询二元组 / 查询二元组总数。
// 分母用查询而不是条目：条目越长越吃亏的写法会让「用户要求界面像成熟产品，有层次有留白…」
// 这种本来就该命中的长条目算成 4%，与实际注入行为不一致（注入只要有一个二元组就留）。
function relevanceOf(itemText, query) {
  const item = bigramsOf(itemText)
  if (item.size === 0 || query.size === 0) return 0
  let hit = 0
  for (const gram of query) if (item.has(gram)) hit += 1
  return hit / query.size
}

function cmdExplain({ positional, flags }) {
  const config = loadConfig()
  const declarations = readJsonl(p('declarations.jsonl'))
  const query = bigramsOf(positional.join(' '))
  const scope = activeScope(flags, config)
  const scored = declarations
    .filter((record) => inScope(record, scope))
    .map((record) => ({
      id: record.id,
      dim: record.dim,
      dimLabel: labelOf(record.dim, config),
      text: record.fact,
      weight: Number(record.confidence ?? 0.5),
      core: record.core === true,
      redline: config.inject.coreDimensions.includes(record.dim),
      partition: partitionOf(record.dim),
      score: relevanceOf(record.fact, query),
    }))
    .sort((a, b) => (b.score - a.score) || (b.weight - a.weight))

  const threshold = Number(config.inject?.relevanceFloor ?? 0.12)
  const carried = scored.filter((item) => item.core || item.redline || item.score >= threshold)
  const dropped = scored.filter((item) => !(item.core || item.redline || item.score >= threshold))

  const why = (item) => {
    if (item.score > 0) return '相关度 ' + (item.score * 100).toFixed(0) + '%'
    if (item.core) return '核心条目，永远带入'
    if (item.redline) return '红线维度，永远带入'
    return '相关度 0%'
  }
  const lines = ['# 本次会带入的条目（' + carried.length + '/' + scored.length + '）', '']
  for (const item of carried.slice(0, 40)) {
    const mark = item.core ? '·核心' : item.redline ? '·红线' : ''
    lines.push('- [' + item.dimLabel + ' ' + item.weight.toFixed(2) + mark + '] ' + why(item) + ' :: ' + item.text)
  }
  if (dropped.length > 0) {
    lines.push('', '# 被相关性挡掉的条目（' + dropped.length + '）', '')
    for (const item of dropped.slice(0, 20)) {
      lines.push('- [' + item.dimLabel + ' ' + item.weight.toFixed(2) + '] 相关度 ' + (item.score * 100).toFixed(0) + '% :: ' + item.text)
    }
  }
  lines.push('', '> 判定：核心/红线维度永远带入；其余相关度 ≥ ' + (threshold * 100).toFixed(0) + '% 才带入，挡掉不等于删除。')
  if (flags.json === true) {
    process.stdout.write(JSON.stringify({ carried, dropped, threshold }, null, 2) + '\n')
    return
  }
  process.stdout.write(lines.join('\n') + '\n')
}

/**
 * 画像健康度：五个会真的影响使用效果的量，每一项都能对应一句「它低了会怎样」。
 */
function healthOf(config, declarations, profile) {
  const items = profile === undefined || profile === null ? [] : flatten(profile, config)
  const declared = declarations.length
  const states = []

  const stampSource = profile?.builtAt ?? profile?.generatedAt
  let stamp = stampSource ? Date.parse(stampSource) : NaN
  if (!Number.isFinite(stamp)) {
    try { stamp = statSync(p('profile.json')).mtimeMs } catch { stamp = NaN }
  }
  const ageDays = Number.isFinite(stamp) ? (Date.now() - stamp) / 86400000 : 999
  const freshness = Math.max(0, Math.min(20, Math.round(20 - ageDays * 2)))
  states.push({ key: 'freshness', label: '新鲜度', score: freshness, max: 20, note: ageDays > 7 ? '画像超过一周没重建' : '画像是最新的' })

  const dimsUsed = new Set(items.map((item) => item.dim)).size
  const coverage = Math.min(20, dimsUsed * 2)
  states.push({ key: 'coverage', label: '覆盖度', score: coverage, max: 20, note: '覆盖 ' + dimsUsed + '/' + config.dimensions.length + ' 个大类' })

  const risky = declarations.filter((record) => blockedPrivacy(record.fact).length > 0).length
  const modelFacts = declarations.filter((record) => record.provenance?.kind === 'model').length
  const precision = Math.max(0, 20 - risky * 4)
  states.push({ key: 'precision', label: '精度', score: Math.round(precision), max: 20, note: risky > 0 ? risky + ' 条含高风险信息' : '没有可疑条目' })

  const conflicts = profile?.conflicts?.length ?? 0
  const consistency = Math.max(0, 20 - conflicts * 4)
  states.push({ key: 'consistency', label: '一致性', score: consistency, max: 20, note: conflicts > 0 ? conflicts + ' 条历史冲突' : '没有未解冲突' })

  const coreCount = items.filter((item) => item.core).length
  const balance = Math.min(20, coreCount * 4)
  states.push({ key: 'balance', label: '重点明确', score: balance, max: 20, note: coreCount > 0 ? coreCount + ' 条核心条目' : '还没标核心条目' })

  const total = states.reduce((sum, state) => sum + state.score, 0)
  const advice = []
  if (freshness < 12) advice.push('跑一次 profile build 让画像跟上最近的对话')
  if (coverage < 8) advice.push('画像只覆盖少数大类，补充偏好与习惯会更像你')
  if (balance < 8) advice.push('把最重要的几条标成核心（面板条目页「设核心」）')
  if (consistency < 16) advice.push('去「冲突与历史」页裁决旧条目')
  if (advice.length === 0) advice.push('暂无问题，保持现在的节奏即可')

  return { total, states, advice, dimsUsed, coreCount, modelFacts, risky, declared }
}

function cmdHealth({ flags }) {
  const config = loadConfig()
  const declarations = readJsonl(p('declarations.jsonl'))
  const profile = readJson(p('profile.json'))
  const health = healthOf(config, declarations, profile)
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(health, null, 2) + '\n')
    return
  }
  const lines = ['画像健康度  ' + health.total + '/100', '']
  for (const state of health.states) {
    const filled = Math.round((state.score / state.max) * 10)
    lines.push('  ' + state.label + '  ' + '█'.repeat(filled) + '·'.repeat(10 - filled) + '  ' + state.score + '/' + state.max + '  ' + state.note)
  }
  lines.push('', '建议：')
  for (const item of health.advice) lines.push('  · ' + item)
  process.stdout.write(lines.join('\n') + '\n')
}

function readHostInfo() {
  const capsPath = p('.host.json')
  let caps
  try { caps = JSON.parse(readFileSync(capsPath, 'utf8')) } catch { caps = undefined }
  const diagPath = p('diag.log')
  let diagTail = []
  try {
    const lines = readFileSync(diagPath, 'utf8').trimEnd().split('\n')
    diagTail = lines.slice(-6).map((line) => line.replace(/^\S+Z\s+\[\d+\]\s*/, ''))
  } catch { diagTail = [] }
  return { caps, diagTail, capsPath }
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
    // 配置损坏时会在这里说一句：面板读到的可能不是用户原本的设置。
    warnings: [...configWarnings],
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
    redactionInfo: { patternCount: (config.redaction.patterns ?? []).length, presets: config.redaction.presets ?? [] },
    health: healthOf(config, readJsonl(p("declarations.jsonl")), profile),
    items: items.map((item, index) => ({
      rank: index + 1,
      partition: partitionOf(item.dim),
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
      // 溯源：面板上要能回答「这条是怎么来的」，所以来源与原话摘录都要透出来
      provenance: item.provenance ?? null,
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
      provenance: r.provenance ?? null,
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
        relevantOnly: config.inject.relevantOnly !== false,
      relevanceFloor: Number(config.inject?.relevanceFloor ?? 0.12),
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
        includeObservedItems: config.build.includeObservedItems === true,
      },
      extract: {
        enabled: config.extract?.enabled !== false,
        everyTurns: config.extract?.everyTurns ?? 1,
        autoAcceptConfidence: config.extract?.autoAcceptConfidence ?? 0.6,
        maxFactsPerTurn: config.extract?.maxFactsPerTurn ?? 5,
        timeoutMs: config.extract?.timeoutMs ?? 45000,
        provider: config.extract?.provider ?? '',
        model: config.extract?.model ?? '',
        minInputChars: config.extract?.minInputChars ?? 60,
        maxInputChars: config.extract?.maxInputChars ?? 6000,
        requireGlobal: config.extract?.requireGlobal !== false,
        maxOutputTokens: config.extract?.maxOutputTokens ?? 900,
        debugLog: config.extract?.debugLog === true,
      },
      capture: {
        turnText: config.capture?.turnText !== false,
        turnSignals: config.capture?.turnSignals !== false,
        toolNames: config.capture?.toolNames !== false,
        userText: config.capture?.userText === true,
      },
      redaction: { mode: config.redaction.mode, presets: config.redaction.presets ?? [] },
      // 面板只能看到配置里「要不要传、传到哪」，密码永远不从这里出来。
      backup: {
        webdav: {
          enabled: config.backup?.webdav?.enabled === true,
          url: config.backup?.webdav?.url ?? '',
          username: config.backup?.webdav?.username ?? '',
          passwordEnv: config.backup?.webdav?.passwordEnv ?? 'DSH_PROFILE_WEBDAV_PASSWORD',
          remoteDir: config.backup?.webdav?.remoteDir ?? 'dsh-user-profile',
          autoUploadOnBuild: config.backup?.webdav?.autoUploadOnBuild === true,
          timeoutMs: config.backup?.webdav?.timeoutMs ?? 20000,
        },
      },
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
    historyItems: historyItems.slice(0, 30),
    // 三类分区汇总（流程第 3 步）：一眼看出「身份/偏好/社交」各有多少条。
    partitions: PARTITIONS.map((p) => ({
      id: p.id,
      label: p.label,
      n: payload.items.filter((item) => item.partition === p.id).length,
    })),
    // 快照列表：面板的「恢复」需要知道有哪些可回退点。
    snapshots: listSnapshots(12),
    // 宿主能力与最近诊断：排障时不用再让用户去翻文件。
    host: readHostInfo(),
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
  if (picked.length === 0) {
    // `--accept all` 在没有候选时是「已经处理完了」，不该当成错误：
    // 面板上「全部接受」是个常规按钮，空队列时报错只会让人以为坏了。
    if (target === 'all') {
      process.stdout.write(`没有待审候选，无需处理。\n`)
      return
    }
    die(`没有匹配的候选：${target}`)
  }
  const pickedIds = new Set(picked.map((r) => r.id))

  if (accept) {
    // 接受时也要挡重复：候选可能是同一句话的第二次提炼，直接 append 会留下两条一样的。
    const declared = readJsonl(p('declarations.jsonl'))
    const seen = new Set(declared.map((row) => `${row?.dim}|${row?.key}|${row?.fact}`))
    let skipped = 0
    for (const record of picked) {
      const fingerprint = `${record.dim}|${record.key}|${record.fact}`
      if (seen.has(fingerprint)) { skipped += 1; continue }
      seen.add(fingerprint)
      appendJsonl(p('declarations.jsonl'), { ...record, acceptedAt: nowIso() })
    }
    if (skipped > 0) process.stdout.write(`（其中 ${skipped} 条与已有条目重复，未重复写入）\n`)
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
  const rawFact = typeof flags.fact === 'string' ? flags.fact.trim() : ''
  // 隐私闸门必须在脱敏之前：命令行的 declare 一直是这么做的，edit 之前漏了这一步 ——
  // 于是「把内容改成身份证号」会被打码后写进去，而规则要的是根本不收。
  if (rawFact.length > 0 && flags.force !== true) {
    const blocked = blockedPrivacy(rawFact)
    if (blocked.length > 0) {
      die(`已拦截：内容含${blocked.join('、')}，不进记忆库（确需记录请显式加 --force）`)
    }
  }
  const edited = rawFact.length > 0
    ? redactWithCount(rawFact, config)
    : { text: record.fact, hits: 0 }
  if (rawFact.length > 0) record.fact = edited.text
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
  // 改内容也要过闸门：改坏了照样会污染注入块
  if (typeof flags.fact === 'string' && flags.fact.trim().length > 0) assertValid(record, config, flags)

  writeJsonl(p('declarations.jsonl'), records)
  appendJsonl(p('changelog.jsonl'), { at: record.editedAt, kind: 'edit', id, before, after: { ...record } })
  rebuildQuietly()
  const redactNote = edited.hits > 0 ? `（已脱敏 ${edited.hits} 处敏感内容）` : ''
  process.stdout.write(`已修改 ${id}：[${record.dim}] ${record.fact}${redactNote}\n（画像已刷新）\n`)
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
  let invalid = 0
  const reasons = new Map()
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
    const cleaned = redactWithCount(fact, config)
    const record = {
      id: newId('dcl'),
      at: nowIso(),
      dim,
      // 默认 key 用「维度 + 内容指纹」：早前用维度名当 key，同一维度导第二条就顶掉第一条
      key: typeof row?.key === 'string' && row.key.length > 0 ? row.key : `${dim}.${factKey(fact)}`,
      fact: cleaned.text,
      source,
      confidence,
      core: row?.core === true,
      scope: 'global',
      importedFrom: file,
      provenance: row?.provenance ?? { kind: 'import', at: nowIso(), excerpt: undefined },
    }
    // 导入是最容易把脏数据带进来的入口：逐条过闸门，不合适就归纳原因、不落库。
    const verdict = validateEntry(record, config)
    if (!verdict.ok) {
      invalid += 1
      for (const reason of verdict.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      continue
    }
    appendJsonl(flags.pending === true ? p('pending.jsonl') : p('declarations.jsonl'), record)
    added += 1
  }
  rebuildQuietly()
  process.stdout.write(`导入 ${added} 条，跳过 ${skipped} 条（空内容或未知维度），不合格 ${invalid} 条；画像已刷新\n`)
  if (invalid > 0) {
    for (const [reason, count] of reasons) process.stdout.write(`  不合格原因 ×${count}：${reason}\n`)
  }
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

function cmdDoctor({ flags }) {
  const caps = readJson(p('.host.json'), undefined)
  const config = loadConfig()
  const lines = []
  const say = (label, text) => lines.push(`${label.padEnd(12)} ${text}`)

  let selfVersion = '（未知）'
  try {
    selfVersion = readJson(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), undefined)?.version ?? selfVersion
  } catch (error) {
    void error
  }
  say('插件', `dsh-user-profile v${selfVersion}`)
  say('Node', process.versions.node)
  say('数据目录', HOME)

  if (caps === undefined) {
    say('宿主能力', '还没有宿主写过 .host.json（插件未加载过，或宿主跑的是还没写能力文件的旧版插件）')
    lines.push('')
    lines.push('  这说明：画像采集/注入/面板此刻都不会自动发生，但 CLI 与 MCP 仍然可用。')
    lines.push('  让宿主写一次：重启一次 dsh（插件启动即写），再运行 profile doctor。')
    lines.push('  如果重启后仍然没有：确认安装的是 0.3.0 及以上（旧版不会写这个文件）。')
  } else {
    say('宿主记录', `${caps.at ?? '未知时间'}（plugin=${caps.plugin ?? '?'}，node=${caps.node ?? '?'}）`)
    const cap = (label, ok, consequence) => say(label, `${ok ? '可用' : '缺失 → ' + consequence}`)
    cap('采集', caps.sessionEvents === true, '不会自动记录每轮对话与工具调用，画像只能靠 declare/import 手工维护')
    cap('注入', caps.preStep === true, '不会在任务开始前自动叠加画像，需要手工把 inject.md 内容给模型')
    cap('面板路由', caps.webServer === true, '设置页里的「用户画像」会读不到数据（页面本身还在）')
    cap('面板鉴权', caps.connection === true, '面板接口没有 cookie 校验，仅限本机访问时依靠端口不暴露')
    cap('智能提取', caps.llm === true, '不会自动从对话里提炼条目，新偏好需手工 declare')
    cap('模块加载', caps.loader === true, '降级为纯行为采集，提取所需的 LLM 组装件拿不到')
    if (Array.isArray(caps.hooksFailed) && caps.hooksFailed.length > 0) {
      say('注册失败', caps.hooksFailed.join('；'))
    }
  }

  lines.push('')
  say('画像', (() => {
    const profile = readJson(p('profile.json'), undefined)
    if (profile === undefined) return '未生成（运行 profile build）'
    return `v${profile.revision} · ${profile.status} · ${profile.stats?.items ?? 0} 条`
  })())
  say('声明', `${readJsonl(p('declarations.jsonl')).length} 条`)
  say('待审', `${countPending()} 条`)
  say('注入', `mode=${config.inject.mode}，预算=${config.inject.maxChars > 0 ? config.inject.maxChars + ' 字' : '不限'}，相关过滤=${config.inject.relevantOnly === false ? '关' : '开'}`)
  say('脱敏', `mode=${config.redaction.mode}，预设=${(config.redaction.presets ?? []).join('/') || '无'}`)
  say('备份', config.backup?.webdav?.enabled ? `WebDAV 已配置（${config.backup.webdav.url}）` : 'WebDAV 未配置（仍可用 --out 本地导出）')

  if (flags?.json === true) {
    process.stdout.write(`${JSON.stringify({ caps, home: HOME, node: process.versions.node }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${lines.join('\n')}\n`)
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
    warnings: [...configWarnings],
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
    ...(summary.warnings ?? []).map((w) => `注意         ${w}`),
  ].join('\n') + '\n')
}

// 允许从命令行/面板写入的配置项；不在表里的一律拒绝（否则拼错的键会悄悄写进 config）
const SET_SPEC = {
  enabled: { type: 'boolean', note: '默认叠加总开关' },
  'inject.mode': { type: 'enum', values: ['always', 'on-request'], note: 'always=每次任务都叠加；on-request=只在被要求时' },
  'inject.maxChars': { type: 'number', min: 0, max: 200000, integer: true, note: '注入正文预算（字符）；0 = 不设上限' },
  'inject.topK': { type: 'number', min: 0, max: 500, integer: true, note: '背景参考段最多带几条；0 = 不限' },
  'inject.coreDimensions': { type: 'dimensionList', note: '这些大类的条目必进注入块' },
  'inject.personalizeDimensions': { type: 'dimensionList', note: '个性化需求时的主要依据' },
  'inject.priorityOnPersonalize': { type: 'boolean', note: '个性化轮是否以画像为主要依据' },
  'inject.relevantOnly': { type: 'boolean', note: '只带入和本轮相关的条目（红线永远带入）' },
  'inject.relevanceFloor': { type: 'number', min: 0, max: 1, note: '相关性门槛：低于这个比例算与本轮无关（默认 0.12）' },
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
  'redaction.mode': { type: 'enum', values: ['unknown', 'off', 'preset', 'patterns'], note: '脱敏模式' },
  'redaction.presets': { type: 'list', values: ['phone', 'email', 'idcard', 'secret'], note: '启用的脱敏预设' },
  'backup.webdav.enabled': { type: 'boolean', note: '是否启用 WebDAV 备份' },
  'backup.webdav.url': { type: 'string', note: 'WebDAV 根地址，如 https://dav.example.com/remote.php/dav/files/me' },
  'backup.webdav.username': { type: 'string', note: 'WebDAV 用户名' },
  'backup.webdav.remoteDir': { type: 'string', note: '远端目录名' },
  'backup.webdav.passwordEnv': { type: 'string', note: '存密码的环境变量名（默认 DSH_PROFILE_WEBDAV_PASSWORD）' },
  'backup.webdav.autoUploadOnBuild': { type: 'boolean', note: '每次重建画像后自动上传' },
  'backup.webdav.timeoutMs': { type: 'number', min: 1000, max: 600000, integer: true, note: '上传超时（毫秒）' },
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
  if (spec.type === 'list') {
    const text = String(rawValue).trim()
    if (text.length === 0) return []
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean)
      } catch {
        // 不是合法 JSON 就按逗号/空格切
      }
    }
    const items = text.split(/[,\s]+/).filter(Boolean)
    if (Array.isArray(spec.values)) {
      const unknown = items.filter((item) => !spec.values.includes(item))
      if (unknown.length > 0) die(`${dotted} 里有不认识的值：${unknown.join(', ')}（可选 ${spec.values.join(' / ')}）`)
    }
    return items
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

/**
 * 体检：逐条过有效性闸门。
 * 默认只报告；`--quarantine` 会把不合格的条目移出仓库、存成 invalid-<时间戳>.jsonl，
 * 再重建画像 —— 也就是说，脏数据要么被修好，要么被拎出来，不会留在里面继续误导注入。
 */
function cmdValidate({ flags }) {
  const config = loadConfig()
  const file = flags.pending === true ? p('pending.jsonl') : p('declarations.jsonl')
  const records = readJsonl(file)
  const bad = []
  for (const record of records) {
    const verdict = validateEntry(record, config)
    if (!verdict.ok) bad.push({ record, reasons: verdict.reasons })
  }
  process.stdout.write(`检查 ${records.length} 条，不合格 ${bad.length} 条\n`)
  for (const { record, reasons } of bad.slice(0, 20)) {
    process.stdout.write(`- ${record.id} [${record.dim}] ${String(record.fact ?? '').slice(0, 40)}\n    ${reasons.join('；')}\n`)
  }
  if (bad.length > 20) process.stdout.write(`（还有 ${bad.length - 20} 条未列出）\n`)
  if (bad.length === 0) return
  if (flags.quarantine !== true) {
    process.stdout.write('（加 --quarantine 可把这些条目移到隔离文件，并从画像中移除）\n')
    return
  }
  const stamp = nowIso().replace(/[:.]/g, '-')
  const dump = p(`invalid-${stamp}.jsonl`)
  const badIds = new Set(bad.map((entry) => entry.record.id))
  writeJsonl(dump, bad.map((entry) => ({ ...entry.record, invalidReasons: entry.reasons })))
  snapshotDeclarations('validate')
  writeJsonl(file, records.filter((record) => !badIds.has(record.id)))
  appendJsonl(p('changelog.jsonl'), { at: nowIso(), kind: 'quarantine', count: bad.length, file: basename(dump) })
  rebuildQuietly()
  process.stdout.write(`已隔离 ${bad.length} 条到 ${basename(dump)}（画像已刷新）\n`)
}

/** 批量清洗已有记录里的敏感值：默认只预览，`--apply` 才写回（写前留快照）。 */
function cmdRedact({ flags }) {
  const config = loadConfig()
  const file = p('declarations.jsonl')
  const records = readJsonl(file)
  let changed = 0
  let hits = 0
  const next = records.map((record) => {
    const fact = typeof record.fact === 'string' ? record.fact : ''
    const result = redactWithCount(fact, config)
    if (result.text === fact) return record
    changed += 1
    hits += result.hits
    return { ...record, fact: result.text, redactedAt: nowIso(), redactedFrom: fact.slice(0, 120) }
  })
  process.stdout.write(`扫描 ${records.length} 条：${changed} 条含敏感内容，共 ${hits} 处\n`)
  if (changed === 0) return
  if (flags.apply !== true) {
    process.stdout.write('（加 --apply 写回；写前会自动留一份快照）\n')
    return
  }
  snapshotDeclarations('redact')
  writeJsonl(file, next)
  appendJsonl(p('changelog.jsonl'), { at: nowIso(), kind: 'redact', changed, hits })
  rebuildQuietly()
  process.stdout.write(`已脱敏 ${changed} 条（${hits} 处）；画像已刷新\n`)
}

// ---------------------------------------------------------------- 备份（WebDAV）

/**
 * WebDAV 备份。
 *
 * 三条硬规矩：
 *   1) 密码不进 config.json —— 只从环境变量或 secrets.json 读；配置文件会被导出、会被
 *      放进仓库，密码放进去等于公开。
 *   2) 默认关闭 —— 往远端写数据必须是用户主动开的。
 *   3) 只传「导出包」：config（已剥掉密码字段）+ declarations + pending + profile。
 *      对话正文从来没落盘，所以这里也不可能有。
 */
function webdavSettings(config) {
  const dav = { ...DEFAULT_CONFIG.backup.webdav, ...(config?.backup?.webdav ?? {}) }
  return {
    ...dav,
    base: String(dav.url ?? '').replace(/\/+$/, ''),
    dir: String(dav.remoteDir ?? '').replace(/^\/+|\/+$/g, ''),
  }
}

function webdavPassword(dav) {
  if (dav.passwordEnv && typeof process.env[dav.passwordEnv] === 'string' && process.env[dav.passwordEnv].length > 0) {
    return process.env[dav.passwordEnv]
  }
  const secrets = readJson(p('secrets.json'), {})
  return typeof secrets?.webdavPassword === 'string' ? secrets.webdavPassword : ''
}

function webdavAuth(dav) {
  const password = webdavPassword(dav)
  if (password.length === 0) {
    die(`缺少 WebDAV 密码：设置环境变量 ${dav.passwordEnv}，或把 {"webdavPassword":"…"} 写进 ${p('secrets.json')}（建议限制为本人可读）`)
  }
  return `Basic ${Buffer.from(`${dav.username}:${password}`).toString('base64')}`
}

async function davFetch(dav, url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), dav.timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Authorization: webdavAuth(dav), ...(init.headers ?? {}) },
    })
  } finally {
    clearTimeout(timer)
  }
}

const davDirUrl = (dav) => `${dav.base}/${encodeURI(dav.dir)}`
const davFileUrl = (dav, name) => `${davDirUrl(dav)}/${encodeURI(name)}`

/** 备份内容：一个自洽的 JSON 包，能直接 `profile import --file` 回灌。 */
function backupPayload(config) {
  const declarations = readJsonl(p('declarations.jsonl'))
  const pending = readJsonl(p('pending.jsonl'))
  const profile = readJson(p('profile.json'), null)
  const safeConfig = JSON.parse(JSON.stringify(config))
  if (safeConfig?.backup?.webdav) {
    // 不把 URL 之外的连接信息带走：备份包可能被放到别处
    safeConfig.backup.webdav = { ...safeConfig.backup.webdav, username: '', passwordEnv: 'DSH_PROFILE_WEBDAV_PASSWORD', url: '' }
  }
  return {
    kind: 'dsh-user-profile-backup',
    schemaVersion: DEFAULT_CONFIG.schemaVersion,
    exportedAt: nowIso(),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'local',
    config: safeConfig,
    declarations,
    pending,
    profile,
  }
}

async function davEnsureDir(dav) {
  // 已存在时 MKCOL 返回 405；不存在则 201。两者都算正常。
  const response = await davFetch(dav, davDirUrl(dav), { method: 'MKCOL' })
  if (response.status >= 400 && response.status !== 405) {
    // 上级目录也可能不存在：再试一次 MKCOL 建一层父目录
    const parent = davDirUrl(dav).replace(/\/[^/]+$/, '')
    if (parent !== dav.base) await davFetch(dav, parent, { method: 'MKCOL' })
    const retry = await davFetch(dav, davDirUrl(dav), { method: 'MKCOL' })
    if (retry.status >= 400 && retry.status !== 405) {
      die(`建不了远端目录 ${davDirUrl(dav)}（HTTP ${retry.status}）；检查 URL 与账号权限`)
    }
  }
}

async function davUpload(dav, name, text) {
  await davEnsureDir(dav)
  const response = await davFetch(dav, davFileUrl(dav, name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: text,
  })
  if (!response.ok) die(`上传失败：HTTP ${response.status} ${response.statusText}`)
  return name
}

async function davList(dav) {
  const response = await davFetch(dav, davDirUrl(dav), {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
  })
  if (response.status === 404) return []
  if (!response.ok) die(`列目录失败：HTTP ${response.status}`)
  const xml = await response.text()
  const names = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => decodeURI(m[1]))
  return names
    .map((href) => href.split('/').filter(Boolean).pop() ?? '')
    .filter((name) => name.endsWith('.json'))
}

/**
 * 备份包加密（流程第 4 步「加密持久化」里唯一真正出门的一环）。
 * 本机磁盘的隔离交给操作系统账户；备份是要上传/拷贝出去的，所以默认就该是密文。
 * AES-256-GCM + scrypt 派生，口令来自 --passphrase / DSH_PROFILE_PASSPHRASE / secrets.json。
 */
const SEALED_KIND = 'dsh-user-profile-backup-sealed'

function profilePassphrase(flags = {}) {
  const fromFlag = typeof flags.passphrase === 'string' && flags.passphrase.length >= 6 ? flags.passphrase : ''
  const fromEnv = typeof process.env.DSH_PROFILE_PASSPHRASE === 'string' && process.env.DSH_PROFILE_PASSPHRASE.length >= 6
    ? process.env.DSH_PROFILE_PASSPHRASE
    : ''
  const fromFile = (() => {
    try {
      const secrets = JSON.parse(readFileSync(p('secrets.json'), 'utf8'))
      const value = secrets?.profilePassphrase
      return typeof value === 'string' && value.length >= 6 ? value : ''
    } catch {
      return ''
    }
  })()
  const pass = fromFlag || fromEnv || fromFile
  if (pass.length < 6) {
    die('加密需要口令（至少 6 位）：用 --passphrase "<口令>"、环境变量 DSH_PROFILE_PASSPHRASE，或写进 secrets.json 的 profilePassphrase')
  }
  return pass
}

function sealText(plainText, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  return JSON.stringify({
    kind: SEALED_KIND,
    v: 1,
    alg: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }, null, 2)
}

function unsealText(sealedText, passphrase) {
  let envelope
  try {
    envelope = JSON.parse(sealedText)
  } catch {
    die('这不是有效的加密包（JSON 解析失败）')
  }
  if (envelope?.kind !== SEALED_KIND) die(`这不是本插件导出的加密包（kind=${envelope?.kind ?? '空'}）`)
  const salt = Buffer.from(String(envelope.salt ?? ''), 'base64')
  const iv = Buffer.from(String(envelope.iv ?? ''), 'base64')
  const tag = Buffer.from(String(envelope.tag ?? ''), 'base64')
  const key = scryptSync(passphrase, salt, 32)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(String(envelope.data ?? ''), 'base64')), decipher.final()]).toString('utf8')
  } catch {
    die('解密失败：口令不对，或文件被改动过')
  }
}

function cmdUnseal({ flags }) {
  if (typeof flags.file !== 'string') die('缺少 --file <加密包.json>')
  if (!existsSync(flags.file)) die(`找不到文件：${flags.file}`)
  const passphrase = profilePassphrase(flags)
  const plain = unsealText(readFileSync(flags.file, 'utf8'), passphrase)
  const out = typeof flags.out === 'string' ? flags.out : flags.file.replace(/\.enc$/, '').replace(/\.json$/, '') + '.json'
  writeFileSync(out, plain.endsWith('\n') ? plain : `${plain}\n`, 'utf8')
  process.stdout.write(`已解密到 ${out}\n（用 profile import --file "${out}" 回灌）\n`)
}

async function cmdBackup({ flags }) {
  const config = loadConfig()
  const dav = webdavSettings(config)

  // 只做本地导出：不配 WebDAV 也能拿走一份可回灌的包
  if (typeof flags.out === 'string') {
    const payload = backupPayload(config)
    const plain = `${JSON.stringify(payload, null, 2)}\n`
    const sealed = flags.encrypt === true
    const text = sealed ? sealText(plain, profilePassphrase(flags)) : plain
    const suffix = sealed ? '.json.enc' : '.json'
    const target = flags.out.endsWith('.json') || flags.out.endsWith('.enc')
      ? flags.out
      : join(flags.out, `user-profile-${nowIso().replace(/[:.]/g, '-')}${suffix}`)
    mkdirSync(flags.out.endsWith('.json') || flags.out.endsWith('.enc') ? join(flags.out, '..') : flags.out, { recursive: true })
    writeFileSync(target, text, 'utf8')
    process.stdout.write(`已导出到 ${target}${sealed ? '（已加密）' : ''}\n  ${payload.declarations.length} 条声明 · 待审 ${payload.pending.length} 条\n`)
    if (sealed) process.stdout.write('  回灌前先解密：profile unseal --file "<该文件>"\n')
    return
  }

  if (dav.base.length === 0) {
    die('还没配 WebDAV：先 `profile set backup.webdav.url https://dav.example.com/remote.php/dav/files/me`（再设 username/passwordEnv），或用 `backup --out <目录>` 只做本地导出')
  }

  if (flags.list === true) {
    const names = await davList(dav)
    process.stdout.write(names.length === 0 ? '远端还没有备份\n' : `${names.map((n) => `  ${n}`).join('\n')}\n`)
    return
  }

  if (typeof flags.pull === 'string') {
    const out = typeof flags.out === 'string' ? flags.out : p(`pulled-${flags.pull}`)
    const response = await davFetch(dav, davFileUrl(dav, flags.pull))
    if (!response.ok) die(`下载失败：HTTP ${response.status}`)
    const text = await response.text()
    writeFileSync(out, text, 'utf8')
    process.stdout.write(`已下载到 ${out}\n（用 profile import --file "${out}" 回灌）\n`)
    return
  }

  const payload = backupPayload(config)
  const plain = `${JSON.stringify(payload, null, 2)}\n`
  // 上传路径默认加密：包一旦离开本机，口令就成了解密的唯一门槛。
  const sealed = flags.encrypt !== false
  const text = sealed ? sealText(plain, profilePassphrase(flags)) : plain
  const stamp = nowIso().replace(/[:.]/g, '-')
  const host = String(payload.host).replace(/[^\w.-]/g, '_')
  const name = `user-profile-${host}-${stamp}.json${sealed ? '.enc' : ''}`

  if (flags['dry-run'] === true) {
    process.stdout.write(`会备份到 ${davFileUrl(dav, name)}${sealed ? '（已加密）' : ''}\n  声明 ${payload.declarations.length} 条 · 待审 ${payload.pending.length} 条 · ${Buffer.byteLength(text)} 字节\n`)
    return
  }
  const uploaded = await davUpload(dav, name, text)
  appendJsonl(p('changelog.jsonl'), { at: nowIso(), kind: 'backup-webdav', file: uploaded, bytes: Buffer.byteLength(text) })
  process.stdout.write(`已备份到 ${davFileUrl(dav, uploaded)}\n  ${payload.declarations.length} 条声明 · ${Buffer.byteLength(text)} 字节\n`)
}

const COMMANDS = {
  init: cmdInit,
  declare: cmdDeclare,
  observe: cmdObserve,
  build: cmdBuild,
  show: cmdShow,
  status: cmdStatus,
  doctor: cmdDoctor,
  panel: cmdPanel,
  review: cmdReview,
  forget: cmdForget,
  edit: cmdEdit,
  merge: cmdMerge,
  import: cmdImport,
  ingest: cmdIngest,
  dims: cmdDims,
  snapshots: cmdSnapshots,
  restore: cmdRestore,
  set: cmdSet,
  reset: cmdReset,
  export: cmdExport,
  validate: cmdValidate,
  explain: cmdExplain,
  health: cmdHealth,
  redact: cmdRedact,
  backup: cmdBackup,
  unseal: cmdUnseal,
}

// 改写型命令必须串行：它们都是「读全量 → 改几条 → 整表写回」，
// 并发时后写的一方会把前一方刚加的记录覆盖掉（这正是丢记录的元凶）。
// 追加型命令（declare/observe）也一并加锁：否则它可能恰好插在别人「读」和「写回」之间，
// 追加的那条会被整表写回抹掉——这正是实测丢 3 条声明的现场。
const MUTATING = new Set(['declare', 'observe', 'build', 'review', 'forget', 'edit', 'merge', 'import', 'dims', 'set', 'reset', 'restore', 'validate', 'redact', 'ingest'])

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional.shift()
  if (command === undefined || command === 'help' || flags.help === true) {
    process.stdout.write(`dsh-profile <命令>\n\n${Object.keys(COMMANDS).map((c) => `  ${c}`).join('\n')}\n\n详见 README.md\n`)
    return
  }
  const handler = COMMANDS[command]
  if (handler === undefined) die(`未知命令 ${command}`)
  // 有的命令（backup 上传备份）是 async 的：withLock 只保证「同步段」互斥，
  // 所以网络类命令不进 MUTATING，这里统一兜住返回的 Promise。
  const outcome = MUTATING.has(command)
    ? withLock(() => handler({ positional, flags }))
    : handler({ positional, flags })
  if (outcome !== undefined && typeof outcome.then === 'function') {
    outcome.catch((error) => die(`命令失败：${error?.message ?? error}`))
  }
}

main()







