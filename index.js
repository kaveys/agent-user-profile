/**
 * dsh-user-profile — 用户画像的采集、注入与生命周期管理。
 *
 * 链路（requirements 1）：
 *   采集  session/event('tool/result' | 'turn/start' | 'turn/end')  → 行为信号（结构化、不含对话正文）
 *   接收  bin/profile.mjs declare                                   → 声明型事实（用户自述 / 模型经用户同意记录）
 *   记录  %USERPROFILE%\.dsh\user-profile\observations\*.jsonl      → 只追加、按月分片
 *   画像  bin/profile.mjs build → profile.json（结构化）+ profile.md（可注入渲染）
 *   调用  agent/pre-step 注入画像块（每轮一次），用户显式喊停则跳过并提示声明
 *
 * 为什么注入不放在 AGENTS.md：AGENTS.md 是静态文件，画像每次任务后都可能变；
 * 走 pre-step 才能做到「读最新、默认叠加、可单轮撤销」。
 *
 * 所有 IO 都包在 try/catch 里：插件绝不能因为画像坏了而挡住用户的正常任务。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

import { relevantOnly } from './lib/relevance.mjs'

export const name = 'dsh-user-profile'
export const inject = []

/** 注入块指纹：用于同一步骤内去重。 */
const MARKER = '<!--dsh-user-profile-->'

/**
 * 诊断落盘（v19.1）：宿主没有日志面板，出问题时唯一能查的就是我们自己写的这行。
 * 只在 DSH_PROFILE_DIAG=0 时关闭；文件固定在数据目录的 diag.log，最多几百行。
 */
const DIAG_FILE = () => join(process.env.DSH_USER_PROFILE_HOME || join(homedir(), '.dsh', 'user-profile'), 'diag.log')
function diag(...parts) {
  if (process.env.DSH_PROFILE_DIAG === '0') return
  try {
    const line = `${new Date().toISOString()} [${process.pid}] ${parts.join(' ')}`
    appendFileSync(DIAG_FILE(), `${line}\n`)
  } catch {
    /* 诊断本身绝不能影响主流程 */
  }
}
diag('module loaded', new URL(import.meta.url).pathname.slice(-24), 'v' + process.env.DSH_PROFILE_DIAG_TAG)

/**
 * 画像十大类（与 bin/profile.mjs 的 DIMENSIONS 同源）。
 * 划分依据：一类只回答一个问题 —— 他是谁 / 在哪做什么 / 会什么 / 何时怎么做事 /
 * 喜欢什么 / 喜欢什么样 / 要达成什么 / 和谁 / 什么不能碰 / 要我怎么说。
 */
const DIMENSION_GUIDE = [
  ['identity', '身份与背景', '称呼、年龄、性别、所在地与时区、母语、学校与专业、家庭角色'],
  ['work', '学业与职业', '在读还是在职、行业与岗位、负责什么、所在团队与项目'],
  ['skills', '能力与工具', '熟悉的技术栈、软件与语言、熟练程度、常用工具链'],
  ['habits', '习惯与节奏', '作息与专注时段、做事方式、整理与备份习惯、更新与交付节奏'],
  ['interests', '兴趣与爱好', '游戏、音乐、影视、阅读、运动、收藏、动手创作'],
  ['taste', '审美与口味', '视觉风格、界面口味、内容偏好、品牌与产品喜好'],
  ['goals', '目标与计划', '正在学什么、短期与长期目标、在推进的项目、时间点'],
  ['social', '关系与协作', '和谁一起做事、团队里的角色、沟通对象、分享与公开习惯'],
  ['constraints', '约束与红线', '禁忌与硬性要求、必须遵守的做法、不可触碰的话题或操作'],
  ['communication', '沟通与表达', '回答长度与结构、语气、用什么语言、要不要表格/代码/清单'],
]

const DIMENSION_IDS = DIMENSION_GUIDE.map(([id]) => id)

/** 提取器的系统提示。要点：只出 JSON、只收可跨会话复用的事实、无依据就返回空数组。 */
const EXTRACT_SYSTEM = [
  '你是用户画像提炼器。输入是一段用户与助手的对话，要求提炼出可以跨会话复用的稳定信息。',
  '',
  '这个画像只有一个用途：让下一次做事时更贴合这个人——选风格、定默认值、写文案、划边界、给推荐。',
  '所以录入标准不是「这条信息有意思」，而是「知道它会不会让我下次做出来的东西更像他要的」。',
  '',
  '录入前的三道检查，三条全过才写：',
  '1. 跨任务：换一个毫不相关的任务，这条还成立吗？「这次要改 client.js」「这轮先不要动配置」换任务就不成立 → 不写。',
  '2. 有用：知道它会不会改变我下次的做法？「用户用 Windows」只有在能推出操作习惯时才算 → 写成「用户在 Windows 上开发插件」这类可用的说法。',
  '3. 归属：说的是用户本人（口味、习惯、能力、目标、边界），不是这次的任务、文件、代码、报错、时间点。',
  '',
  '一律不要：本次/这一轮/当前任务的细节、文件名与路径、端口与版本号、报错原文、命令、一次性要求、临时约定。',
  '',
  '画像分十大类，一类只回答一个问题。只能落进这些大类：',
  ...DIMENSION_GUIDE.map(([id, label, hint]) => '- ' + id + ' ' + label + '：' + hint),
  '',
  '分类最容易混的两对：',
  '- work 是「在哪做什么」，skills 是「会什么」；学科与学校进 identity 的 school/major，岗位进 work。',
  '- taste 是「喜欢什么样」（界面风格、内容口味），communication 是「要我怎么说」（长度、结构、语气、语言）。',
  '- 会随项目变的东西进 goals，不要占用 identity。',
  '',
  '严格规则：',
  '1. 必须能从对话中找到明确依据；一次性的任务细节、临时指令、文件名、路径、命令行、报错内容都不要。',
  '2. 每条 fact 是一句自足的中文陈述，脱离上下文也读得懂，主语是「用户」，不超过 40 字。',
  '3. key 写成「维度.细分」（小写英文，如 skills.editor、habits.hours、interests.game）；同类条目复用同一个 key，方便新值覆盖旧值。',
  '3.1 输入里给了「已有画像条目」时，凡是同一件事（哪怕措辞不同）必须复用其中已有的 key，只更新 fact 文字；不要为同一件事新造 key。',
  '4. confidence：用户明确说出的 0.9；从反复行为推断的 0.6；仅一次表现推断的 0.45。',
  '5. scope：跨任务都成立的写 "global"；只在这个项目/工作区成立的写 "project"。**拿不准就写 project**——宁可少记，也别把项目细节写进用户画像。',
  '6. 没有值得长期记住的内容，就返回 {"facts": []}。',
  '',
  '只输出 JSON，不要解释、不要 Markdown 代码块：',
  '{"facts":[{"dim":"skills","key":"skills.editor","fact":"用户习惯用 VS Code 改代码","confidence":0.9,"scope":"global"}]}',
].join('\n')

/** 用户明确喊停时的替代注入（不含任何画像内容，只要求模型声明本次未用画像）。 */
const SUPPRESS_NOTICE = [
  '<system-reminder>',
  `${MARKER}`,
  '用户本轮明确要求不使用用户画像：本次不注入任何画像内容。',
  '请在最终结果中原样说明一句「本次未结合用户画像」，然后完全按用户本轮指令执行。',
  '</system-reminder>',
].join('\n')

const DEFAULT_CONFIG = {
  schemaVersion: 3,
  enabled: true,
  inject: {
    mode: 'always',
    maxChars: 0,
    topK: 0,
    coreDimensions: ['constraints', 'identity'],
    // 个性化需求以这些维度为主要依据（与 CLI 的 personalizeDimensions 同源）
    personalizeDimensions: ['taste', 'communication', 'habits', 'interests', 'goals'],
    priorityOnPersonalize: true,
    // 只带入和本轮相关的条目（流程第 5 步：记忆不自动扩散）；红线永远带入。
    relevantOnly: true,
    // 命中即判定「本轮需要个性化」，画像升级为主要依据
    personalizePatterns: [
      '个性化', '风格', '调性', '审美', '好看', '配色', '视觉', '排版', '界面', '布局',
      '文案', '措辞', '语气', '口吻', '称呼我', '我的习惯', '按我的', '照我的', '我喜欢',
      '推荐', '选型', '默认', '偏好', '口味', '定制', '适合我',
    ],
    announceSuppressed: true,
    maxAgeDays: 30,
    distillHint: true,
  },
  capture: { turnSignals: true, toolNames: true, userText: false, turnText: true },
  // 智能提取：每轮结束把这轮对话压成几条可复用的画像事实。
  // 正文绝不落盘（只在内存里拼成一次请求），落盘的只有提炼结果。
  extract: {
    enabled: true,
    provider: '',
    model: '',
    everyTurns: 1,
    minInputChars: 60,
    maxInputChars: 6000,
    maxFactsPerTurn: 5,
    autoAcceptConfidence: 0.7,
    // 只把「可能对全局有用」的写进画像；项目局部的一律丢（见 EXTRACT_SYSTEM 的三道检查）
    requireGlobal: true,
    // 流程第 1 步：纯干活的一轮（翻译、做题、查报错）不提炼，除非用户在讲自己
    skipEphemeralTurns: true,
    timeoutMs: 45000,
    maxOutputTokens: 900,
    debugLog: false,
  },
  build: {
    observedTtlDays: 90,
    minEvidenceForPortrait: 3,
    declaredWeight: 1,
    observedWeight: 0.4,
    autoBuild: true,
    autoBuildMinIntervalMs: 60000,
  },
  conflicts: { strategy: 'newest' },
  scope: { id: '' },
  suppressPatterns: [
    '不使用画像', '不要使用画像', '不用画像', '别用画像', '忽略画像', '不要结合画像',
    '不结合画像', '不带画像', '不参考画像', '画像先放一边', '清空画像上下文',
    'no profile', 'without profile', '--no-profile', 'ignore the profile',
  ],
}

const home = () => process.env.DSH_USER_PROFILE_HOME || join(homedir(), '.dsh', 'user-profile')
const p = (...parts) => join(home(), ...parts)

/** 极简 mtime 缓存：画像和配置都可能在外部被 CLI 改写。 */
function cached(file, parse) {
  let stamp = -1
  let value
  return () => {
    try {
      const info = statSync(file)
      if (info.mtimeMs !== stamp) {
        stamp = info.mtimeMs
        value = parse(readFileSync(file, 'utf8'))
      }
      return value
    } catch {
      stamp = -1
      return undefined
    }
  }
}

const parseConfig = (text) => {
  const raw = JSON.parse(text)
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    inject: { ...DEFAULT_CONFIG.inject, ...(raw.inject ?? {}) },
    capture: { ...DEFAULT_CONFIG.capture, ...(raw.capture ?? {}) },
    extract: { ...DEFAULT_CONFIG.extract, ...(raw.extract ?? {}) },
    build: { ...DEFAULT_CONFIG.build, ...(raw.build ?? {}) },
    suppressPatterns: Array.isArray(raw.suppressPatterns) && raw.suppressPatterns.length > 0
      ? raw.suppressPatterns
      : DEFAULT_CONFIG.suppressPatterns,
  }
}

const parseProfile = (text) => JSON.parse(text)
// 注入正文优先用 build 预渲染的 inject.md（已做「核心必进 + 其余 topK」两段式预算），
// 缺失时退回 profile.md（老版本产物，由 buildBlock 兜底截断）。
/**
 * 注意：路径必须每次调用时再算。
 * 旧写法把 p('inject.md') 放在 cached(...) 的参数里，模块加载那一刻就把 DSH_USER_PROFILE_HOME
 * 固化进了路径；之后再改环境变量（测试隔离、宿主切换 profile、MCP 子进程复用同一模块）
 * 都会读回旧目录——表现就是「换了数据目录，注入的还是上一个用户的画像」。
 * 缓存按最终路径分桶，才不会串。
 */
/**
 * 通用惰性缓存：路径在调用时再算，缓存按最终路径分桶。
 * 原因见下面 cachedText 的注释——cached(p(...)) 会把模块加载时的环境变量固化。
 */
const jsonCache = new Map()
function cachedJson(file, parse) {
  let reader = jsonCache.get(file)
  if (reader === undefined) {
    reader = cached(file, parse)
    jsonCache.set(file, reader)
  }
  return reader()
}

const mdCache = new Map()
function cachedText(file) {
  let reader = mdCache.get(file)
  if (reader === undefined) {
    reader = cached(file, (text) => text)
    mdCache.set(file, reader)
  }
  return reader()
}
/**
 * 丢掉「别的项目」的条目（v37）。
 * 注入块里项目条目长这样：- [已确认 1 · project:proj-A] 这个仓库用 pnpm 管依赖
 * 只保留当前项目的与全局的（没有 project: 标记的即全局/无作用域）。
 * inject.md 仍用 build --all-scopes 生成（面板要看全部），过滤发生在注入这一步。
 */
export function filterForeignScope(md, currentScopeId) {
  const lines = String(md).split('\n')
  const kept = []
  let dropped = 0
  for (const line of lines) {
    const marker = /·\s*project:([^\]\s]+)/.exec(line)
    if (marker !== null && marker[1] !== currentScopeId) {
      dropped += 1
      continue
    }
    kept.push(line)
  }
  return { text: dropped === 0 ? md : kept.join('\n'), dropped }
}

const readInjectMd = () => cachedText(p('inject.md'))
const readPortraitMd = () => cachedText(p('profile.md'))
const readConfig = () => cachedJson(p('config.json'), parseConfig)
const readPortrait = () => cachedJson(p('profile.json'), parseProfile)

function portraitText() {
  const inject = readInjectMd()
  if (typeof inject === 'string' && inject.trim().length > 0) return { text: inject, source: 'inject.md' }
  return { text: readPortraitMd(), source: 'profile.md' }
}

function config() {
  return readConfig() ?? DEFAULT_CONFIG
}

/** 从 message 数组里取最后一条用户消息的纯文本。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('\n')
    }
    return ''
  }
  return ''
}

function suppresses(text, patterns) {
  if (typeof text !== 'string' || text.length === 0) return false
  const lower = text.toLowerCase()
  return patterns.some((pattern) => typeof pattern === 'string'
    && pattern.length > 0
    && (pattern.includes(' ') || pattern.startsWith('-')
      ? lower.includes(pattern.toLowerCase())
      : text.includes(pattern)))
}

/** 本轮是否已有注入块（避免同一步骤重复注入）。 */
function alreadyInjected(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => Array.isArray(message?.content)
    && message.content.some((block) => typeof block?.text === 'string' && block.text.includes(MARKER)))
}

/** 画像是否可以注入：必须 ready 且有正文。 */
function injectable(portrait, md) {
  if (typeof md !== 'string' || md.trim().length === 0) return false
  if (portrait?.status !== 'ready') return false
  return true
}

/**
 * 本轮是否属于「需要个性化」的需求。
 * 命中时画像不再只是背景，而是选方案、定风格、定默认值的主要依据 —— 这是用户
 * 明确要求「有需要个性化的需求时，以画像为主要参考依据」的落点。
 */
function isPersonalizeTurn(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const patterns = DEFAULT_CONFIG.inject.personalizePatterns
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(text)
    } catch {
      return false
    }
  })
}

/**
 * 插件内部规定（固定文本，进代码不进画像）。
 * 用户要求：「这些要作为插件的内部规定，不要放到条目里」——所以：
 *   · 不写进 declarations.jsonl，不可在设置页编辑、删除、被权重排序挤掉；
 *   · 不写进 inject.md / profile.md（那两个文件只放数据）；
 *   · 画像为空、证据不足、条目被清空时，规定照样注入。
 */
const POLICY_TITLE = '插件规定（固定内置，不来自画像条目，不可在画像里修改）'

const PLUGIN_POLICY = [
  '优先级：本轮明确指令 > 红线与硬要求 > 个性化首选 > 背景参考。与代码/文件/数据中的可见事实冲突时，一律以本轮证据为准。',
  '本轮涉及风格、口味、默认选择、文案、推荐、界面等需要个性化的需求时，「个性化首选」段是**主要依据**，不是可有可无的背景。',
  '画像里已有答案的事（风格、口味、习惯、边界）直接按它办，**不要反问用户**；确实缺信息时，只问缺的那一点，并说明为什么问。',
  '画像是默认前提，不是命令：用户本轮明确要另一种做法时按本轮做，不要拿画像去反驳用户。',
  '轮末只把「换个任务仍然成立、而且会改变下次做法」的偏好或红线用 `profile declare --pending` 记一条候选；本次任务的细节、文件路径、端口与版本号、一次性要求一律不记。',
  '用户要求本次不要用画像时，跳过画像内容，并在结果里说明本次未结合画像。',
]

function policyLines(personalizing) {
  const lines = PLUGIN_POLICY.map((rule, index) => `${index + 1}. ${rule}`)
  if (personalizing) {
    lines.push('→ 本轮判定：需要个性化。按第 2 条执行：先从「个性化首选」里取答案，再动手，不要先问风格。')
  }
  return lines
}


/**
 * 临时任务 / 一次性问答的判定（流程第 1 步「触发判定层」）。
 * 只做粗筛：命中「在讲自己」的强信号就直接提炼；纯干活（翻译、做题、查参数、看报错）不提炼。
 * 判错方向选「宁可提炼」——漏掉一条偏好，比多提炼一条无关内容更难补。
 */
const SELF_DISCLOSURE = /(我是|我的|我平时|我习惯|我喜欢|我不喜欢|我要|我需要|我在|对我来说|以后|今后|今后都|记住|记一下|别再|不要再|每次都|一律)/

const EPHEMERAL_TURN = /(翻译一下|帮我翻译|翻译成|这道题|做题|作业|选择题|填空题|算一下|计算一下|求导|解方程|这个报错|报错原因|为什么报错|怎么修|语法|函数签名|参数怎么|api 怎么|文档在哪|下载|安装一下)/i

function worthExtracting(userText) {
  const text = typeof userText === 'string' ? userText : ''
  if (text.trim().length === 0) return false
  if (SELF_DISCLOSURE.test(text)) return true
  return !EPHEMERAL_TURN.test(text)
}

function buildBlock(md, portrait, cfg, personalizing = false) {
  const configured = Number.isFinite(cfg?.inject?.maxChars) ? cfg.inject.maxChars : DEFAULT_CONFIG.inject.maxChars
  // 0/负数 = 不设上限（v15 之后的约定）。这里绝不能把 0 当成「预算 0 字」，
  // 否则整份画像会被截成一行省略号——这个坑正是被「默认叠加：注入画像」用例抓到的。
  const limit = configured > 0 ? configured : 0
  // inject.md 已按预算切好，一般不会触发截断；profile.md 兜底时才可能截。
  const raw = typeof md === 'string' ? md : ''
  const body = limit > 0 && raw.length > limit ? `${raw.slice(0, limit)}\n…（画像正文已按 maxChars 截断）` : raw

  const lines = ['<system-reminder>', MARKER, `【${POLICY_TITLE}】`, ...policyLines(personalizing), '']

  if (body.trim().length === 0) {
    // 画像为空/证据不足也要把规定送到：否则「规定」就变成了只有有画像时才生效的条款。
    lines.push('【画像内容】', '（当前没有可用条目：本轮按通用方式处理，不要因此改变上面的规定。）')
  } else {
    const revision = portrait?.revision ?? '?'
    const builtAt = portrait?.builtAt ?? '未记录'
    const items = portrait?.stats?.items ?? '?'
    const pending = portrait?.stats?.pending ?? 0
    lines.push(
      '【画像内容】',
      `画像版本 v${revision}，生成于 ${builtAt}，共 ${items} 条${pending > 0 ? `（另有 ${pending} 条待审候选未计入）` : ''}。`,
      '',
      body,
    )
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}

/**
 * 宿主兼容层：不同 DSH 版本的事件名/服务名不完全一致，这里把已知别名收敛成规范名。
 * 只做「同义归一」，不做猜测——名字对不上就照原样返回，交给 switch 的 default 忽略。
 */
const EVENT_ALIASES = new Map([
  ['tool_call', 'tool/call'],
  ['toolCall', 'tool/call'],
  ['tool-call', 'tool/call'],
  ['tool_result', 'tool/result'],
  ['toolResult', 'tool/result'],
  ['tool-result', 'tool/result'],
  ['turn_start', 'turn/start'],
  ['turnStart', 'turn/start'],
  ['turn_end', 'turn/end'],
  ['turnEnd', 'turn/end'],
  ['user_message', 'user/message'],
  ['userMessage', 'user/message'],
  ['assistant_message', 'assistant/message'],
  ['assistantMessage', 'assistant/message'],
  ['request_header', 'request/header'],
  ['requestHeader', 'request/header'],
])
const canonicalEventType = (type) => (typeof type === 'string' ? (EVENT_ALIASES.get(type) ?? type) : '')

export function apply(ctx, config0) {
  // 宿主侧加载失败的代价是「整个插件消失」，比功能降级严重得多。
  // 所以这里再兜一层：异常只记诊断，绝不向外抛。
  diag('apply start')
  try {
    applyInner(ctx, config0)
    diag('apply returned')
  } catch (error) {
    const detail = error && error.stack ? String(error.stack).slice(0, 1200) : String(error)
    diag('apply threw', detail.replace(/\n/g, ' | '))
    try {
      console.error('[dsh-user-profile] apply failed:', error?.message ?? error)
    } catch {
      /* 连 console 都没有就算了 */
    }
  }
}

function applyInner(ctx, config0) {
  const debug = process.env.DSH_USER_PROFILE_LOG === '1'
  const log = (...args) => {
    if (debug) console.log('[dsh-user-profile]', ...args)
  }

  /**
   * 能力探测：每个宿主版本提供的服务不一样，插件必须能「少给一半 API 也照常跑」。
   * 所有降级都在这里留痕，并落盘成 .host.json，CLI 的 `profile doctor` 直接读它。
   */
  const caps = {
    plugin: 'cordis',
    sessionEvents: false,
    preStep: false,
    webServer: false,
    connection: false,
    llm: false,
    loader: hasMethod('loader', 'import'),
    hooksFailed: [],
  }
  const hostCapsFile = () => join(process.env.DSH_USER_PROFILE_HOME || join(homedir(), '.dsh', 'user-profile'), '.host.json')
  let capsWritten = ''
  function writeHostCaps(extra = {}) {
    try {
      const payload = {
        at: new Date().toISOString(),
        plugin: 'dsh-user-profile',
        node: process.versions?.node,
        ...caps,
        ...extra,
      }
      const text = JSON.stringify(payload, null, 2)
      if (text === capsWritten) return
      const file = hostCapsFile()
      const dir = dirname(file)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(file, `${text}\n`, 'utf8')
      capsWritten = text
    } catch (error) {
      log('write .host.json failed', error?.message)
    }
  }
  /** 老宿主可能没有某个事件主题：注册失败不该把整个插件拖下水。 */

  /**
   * 安全探测服务：cordis 的 ctx 上取未就绪服务会直接抛（不是返回 undefined），
   * 所以任何能力探测都必须包一层 try，否则「探测」本身会把插件加载搞挂。
   */
  function serviceOf(name) {
    try {
      return ctx?.[name]
    } catch {
      return undefined
    }
  }
  function hasMethod(service, method) {
    try {
      const target = serviceOf(service)
      return typeof target?.[method] === 'function'
    } catch {
      return false
    }
  }
  function onSafe(topic, handler, flagKey) {
    try {
      const on = serviceOf('on')
      if (typeof on !== 'function') throw new Error('ctx.on 不存在')
      on.call(ctx, topic, handler)
      if (flagKey) caps[flagKey] = true
    } catch (error) {
      diag('hook register failed', topic, String(error?.message ?? error))
      caps.hooksFailed.push(`${topic}: ${error?.message ?? error}`)
      log(`无法注册 ${topic}`, error?.message)
    }
  }

  // ------------------------------------------------------------ 设置页面板的数据源
  // 面板不自己算权重：直接借 CLI 的 `panel` 子命令，保证「页面看到的就是注入用的那份排序」。
  const PANEL_ROUTE = '/user-profile/panel.json'
const ACTION_ROUTE = '/user-profile/action'
  const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'profile.mjs')
  let panelCache = { at: 0, body: '' }

  function panelBody() {
    const stamp = Date.now()
    if (stamp - panelCache.at < 2000 && panelCache.body.length > 0) return panelCache.body
    let body
    try {
      const out = execFileSync(process.execPath, [CLI_PATH, 'panel'], {
        encoding: 'utf8',
        timeout: 10000,
        env: process.env,
        windowsHide: true,
      })
      body = JSON.stringify(JSON.parse(out))
    } catch (error) {
      body = JSON.stringify({ ok: false, error: String(error?.message ?? error) })
    }
    panelCache = { at: stamp, body }
    return body
  }

  function panelHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    try {
      const body = panelBody()
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      log('panel route failed', error?.message)
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }

  // ------------------------------------------------------------ 面板写操作
  // 面板不能只读：用户想加一条、删一条、裁决一条待审候选时，不该被逼回命令行。
  // 这里只做「把面板表单翻译成 CLI 调用」这一件事，写入语义全部复用 CLI，
  // 保证面板和命令行产生完全一样的数据（同一套校验、同一份审计）。
  function runCli(args, timeoutMs = 15000) {
    try {
      const out = execFileSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: process.env,
        windowsHide: true,
      })
      return { ok: true, output: String(out ?? '').trim() }
    } catch (error) {
      const detail = String(error?.stdout ?? '').trim() || String(error?.message ?? error)
      return { ok: false, error: detail.slice(0, 500) }
    }
  }

  const ACTIONS = {
    declare(input) {
      const dim = typeof input.dim === 'string' && input.dim.length > 0 ? input.dim : 'taste'
      const fact = typeof input.fact === 'string' ? input.fact.trim() : ''
      if (fact.length === 0) return { ok: false, error: '内容不能为空' }
      const args = ['declare', '--dim', dim, '--fact', fact]
      if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      if (input.core === true) args.push('--core')
      if (input.pending === true) args.push('--pending')
      // v35 时效：临时状态可以带到期时间（"7d" 或 "2026-12-31"）
      if (typeof input.ttl === 'string' && input.ttl.length > 0) args.push('--ttl', input.ttl)
      if (typeof input.expires === 'string' && input.expires.length > 0) args.push('--expires', input.expires)
      return runCli(args)
    },
    /** v35 到期清理：把过了保质期的临时状态归档掉（清理前自动留快照）。 */
    forgetExpired() {
      return runCli(['forget', '--expired'])
    },
    forget(input) {
      const args = ['forget']
      const ids = Array.isArray(input.ids) ? input.ids.join(',') : input.ids
      if (input.all === true) args.push('--all')
      // v37：面板「批量删除」发的是 ids，原来只有 id/key/dim 分支 → 每次都报「缺少 id」，
      // 而前端又把失败当成成功提示，用户看到「已删除 N 条」但什么都没发生。
      else if (typeof ids === 'string' && ids.length > 0) args.push('--ids', ids)
      else if (typeof input.id === 'string' && input.id.length > 0) args.push('--id', input.id)
      else if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      else if (typeof input.dim === 'string' && input.dim.length > 0) args.push('--dim', input.dim)
      else return { ok: false, error: '缺少 id / key / dim / all' }
      if (input.pending === true) args.push('--pending')
      return runCli(args)
    },
    /** 软失效：条目退出画像但记录留着（面板「删除」旁边那个「先放下」）。 */
    retire(input) {
      const args = ['retire']
      const ids = Array.isArray(input.ids) ? input.ids.join(',') : input.ids
      if (input.all === true) args.push('--all')
      else if (typeof ids === 'string' && ids.length > 0) args.push('--ids', ids)
      else if (typeof input.id === 'string' && input.id.length > 0) args.push('--id', input.id)
      else if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      else if (typeof input.dim === 'string' && input.dim.length > 0) args.push('--dim', input.dim)
      else return { ok: false, error: '缺少 id / ids / key / dim / all' }
      if (typeof input.reason === 'string' && input.reason.trim().length > 0) args.push('--reason', input.reason.trim())
      return runCli(args)
    },
    unretire(input) {
      const args = ['unretire']
      const ids = Array.isArray(input.ids) ? input.ids.join(',') : input.ids
      if (input.all === true) args.push('--all')
      else if (typeof ids === 'string' && ids.length > 0) args.push('--ids', ids)
      else if (typeof input.id === 'string' && input.id.length > 0) args.push('--id', input.id)
      else if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      else if (typeof input.dim === 'string' && input.dim.length > 0) args.push('--dim', input.dim)
      else return { ok: false, error: '缺少 id / ids / key / dim / all' }
      return runCli(args)
    },
    /** 置顶：每轮注入必带，不受相关性闸门影响。 */
    pin(input) {
      const args = ['pin']
      const ids = Array.isArray(input.ids) ? input.ids.join(',') : input.ids
      if (input.all === true) args.push('--all')
      else if (typeof ids === 'string' && ids.length > 0) args.push('--ids', ids)
      else if (typeof input.id === 'string' && input.id.length > 0) args.push('--id', input.id)
      else if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      else if (typeof input.dim === 'string' && input.dim.length > 0) args.push('--dim', input.dim)
      else return { ok: false, error: '缺少 id / ids / key / dim / all' }
      return runCli(args)
    },
    unpin(input) {
      const args = ['unpin']
      const ids = Array.isArray(input.ids) ? input.ids.join(',') : input.ids
      if (input.all === true) args.push('--all')
      else if (typeof ids === 'string' && ids.length > 0) args.push('--ids', ids)
      else if (typeof input.id === 'string' && input.id.length > 0) args.push('--id', input.id)
      else if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      else if (typeof input.dim === 'string' && input.dim.length > 0) args.push('--dim', input.dim)
      else return { ok: false, error: '缺少 id / ids / key / dim / all' }
      return runCli(args)
    },
    edit(input) {
      const ids = Array.isArray(input.ids) ? input.ids.join(',') : input.ids
      const hasIds = typeof ids === 'string' && ids.length > 0
      if (!hasIds && (typeof input.id !== 'string' || input.id.length === 0)) return { ok: false, error: '缺少 id / ids' }
      // v37：批量「设为核心」走 --ids（只改状态）。CLI 侧早就支持，宿主没透传。
      const args = ['edit', hasIds ? '--ids' : '--id', hasIds ? ids : input.id]
      if (typeof input.fact === 'string' && input.fact.trim().length > 0) args.push('--fact', input.fact.trim())
      if (typeof input.dim === 'string' && input.dim.length > 0) args.push('--dim', input.dim)
      if (typeof input.key === 'string' && input.key.length > 0) args.push('--key', input.key)
      const weight = Number.isFinite(Number(input.weight)) ? Number(input.weight) : input.confidence
      if (Number.isFinite(Number(weight))) args.push('--weight', String(Number(weight)))
      if (input.core === true) args.push('--core', 'true')
      if (input.core === false) args.push('--core', 'false')
      return runCli(args)
    },
    review(input) {
      const args = ['review']
      if (typeof input.accept === 'string' && input.accept.length > 0) args.push('--accept', input.accept)
      else if (typeof input.reject === 'string' && input.reject.length > 0) args.push('--reject', input.reject)
      else return { ok: false, error: '缺少 accept / reject' }
      return runCli(args)
    },
    restore(input) {
      const name = typeof input.name === 'string' ? input.name : ''
      // 只允许快照目录内的既有文件名：面板传来的字符串不能当路径用。
      if (!/^declarations-[\w.-]+\.jsonl$/.test(name)) return { ok: false, error: '快照名不合法' }
      return runCli(['restore', '--name', name])
    },
    set(input) {
      if (typeof input.key !== 'string' || input.key.length === 0) return { ok: false, error: '缺少 key' }
      return runCli(['set', input.key, String(input.value ?? '')])
    },
    dims(input) {
      if (input.add === true) {
        if (typeof input.id !== 'string' || typeof input.label !== 'string') return { ok: false, error: '缺少 id / label' }
        return runCli(['dims', 'add', input.id, input.label])
      }
      if (input.remove === true) {
        if (typeof input.id !== 'string') return { ok: false, error: '缺少 id' }
        return runCli(['dims', 'remove', input.id])
      }
      return runCli(['dims', 'list'])
    },
    /** 体检：默认只报告，不动数据；带 quarantine 才把不合格条目隔离出库。 */
    validate(input) {
      const args = ['validate']
      if (input?.pending === true) args.push('--pending')
      if (input?.quarantine === true) args.push('--quarantine')
      return runCli(args)
    },
    /** 脱敏：默认只统计「有几条含敏感内容」，apply 才真写回（写回前自动留快照）。 */
    redact(input) {
      return runCli(input?.apply === true ? ['redact', '--apply'] : ['redact'])
    },
    /** 备份：dry-run 只算体积 / out 本地导出 / upload 推 WebDAV / list 列远端。 */
    backup(input) {
      const mode = typeof input?.mode === 'string' ? input.mode : 'dry-run'
      if (mode === 'out') {
        if (typeof input.dir !== 'string' || input.dir.length === 0) return { ok: false, error: '缺少 dir' }
        const args = ['backup', '--out', input.dir]
        if (input.encrypt === true) args.push('--encrypt')
        return runCli(args)
      }
      if (mode === 'list') return runCli(['backup', '--list'], 40000)
      if (mode === 'upload') return runCli(['backup'], 60000)
      return runCli(['backup', '--dry-run'], 40000)
    },
    build() {
      return runCli(['build', '--all-scopes'])
    },
    /** 手动合并两条声明：自动去重只认字面相似度，语义相同的还得人来判。 */
    merge(input) {
      if (typeof input.keep !== 'string' || typeof input.drop !== 'string') return { ok: false, error: '缺少 keep / drop' }
      return runCli(['merge', '--keep', input.keep, '--drop', input.drop])
    },
    /** 主动合并相似条目（v25）：默认只预览，apply=true 才落库（会先留快照）。 */
    dedupe(input) {
      const args = ['dedupe']
      if (input.apply === true) args.push('--apply')
      if (Number.isFinite(Number(input.threshold))) args.push('--threshold', String(Number(input.threshold)))
      return runCli(args, 30000)
    },
    /** 语义合并：字面抓不到的「换了说法」交给模型判，判完直接回灌（可撤销：快照）。 */
    async 'dedupe-semantic'() {
      const cfg = config()
      const fallback = typeof cfg.extract?.provider === 'string' && cfg.extract.provider.length > 0
        && typeof cfg.extract?.model === 'string' && cfg.extract.model.length > 0
        ? { provider: cfg.extract.provider, model: cfg.extract.model }
        : null
      const result = await semanticMerge(lastRoute ?? fallback)
      if (result.pairs === 0) return { ok: true, output: '没有发现候选对（字面相似度与共现片段都没命中）' }
      if (result.judged === 0) return { ok: false, error: `候选 ${result.pairs} 对，但模型判定失败或不可用（看 diag.log）` }
      return {
        ok: true,
        output: `候选 ${result.pairs} 对 → 模型判定同义 ${result.judged} 对 → 已合并 ${result.applied} 组（画像已刷新；可在「恢复点」整批还原）`,
      }
    },
    /** 粘贴 JSON 批量导入：CLI 只吃文件，所以先落一个临时文件再交给它。 */
    // 从别的 AI 搬回画像（v24）：面板里贴一段「你掌握了我什么」，CLI 负责切分/归类/定权。
    // 文本走临时文件而不是命令行参数 —— Windows 单个参数上限 32k，整段答复很容易超。
    ingest(input) {
      const text = typeof input.text === 'string' ? input.text : ''
      if (text.trim().length === 0) return { ok: false, error: '请先贴入别的 AI 给出的答复' }
      const source = typeof input.source === 'string' && input.source.trim().length > 0
        ? input.source.trim().slice(0, 40)
        : 'other-ai'
      const file = join(tmpdir(), `dsh-user-profile-ingest-${Date.now()}-${process.pid}.txt`)
      writeFileSync(file, text, 'utf8')
      try {
        const args = ['ingest', '--file', file, '--source', source]
        if (input.apply === true) args.push('--apply')
        return runCli(args, 30000)
      } finally {
        try {
          unlinkSync(file)
        } catch {
          // 临时文件删不掉不影响结果
        }
      }
    },

    importText(input) {
      const items = Array.isArray(input.items) ? input.items : undefined
      if (items === undefined) return { ok: false, error: '缺少 items 数组' }
      const file = join(tmpdir(), `dsh-user-profile-import-${Date.now()}-${process.pid}.json`)
      writeFileSync(file, JSON.stringify({ items }), 'utf8')
      try {
        return runCli(['import', '--file', file, ...(input.pending === true ? ['--pending'] : [])])
      } finally {
        try {
          unlinkSync(file)
        } catch {
          // 临时文件删不掉不影响结果
        }
      }
    },
    export(input) {
      const out = typeof input.out === 'string' && input.out.length > 0
        ? input.out
        : join(homedir(), '.dsh', 'user-profile', 'export', String(Date.now()))
      return runCli(['export', '--out', out])
    },
    reset(input) {
      if (input.confirm !== true) return { ok: false, error: '重置会归档并清空画像数据，需要 confirm: true' }
      return runCli(['reset', '--yes'])
    },
    /** 设置页保存：一次提交多项，逐条 set 之后立刻 build，让画像和面板同步。 */
    settings(input) {
      const entries = input?.entries !== null && typeof input?.entries === 'object' ? input.entries : {}
      const keys = Object.keys(entries)
      if (keys.length === 0) return { ok: false, error: '缺少 entries' }
      for (const key of keys) {
        const raw = entries[key]
        // 字符串原样传（别 JSON.stringify：会把 1600 变成 "1600"，CLI 侧 Number() 变 NaN）
        const value = typeof raw === 'string' ? raw
          : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw)
          : JSON.stringify(raw)
        const result = runCli(['set', key, value])
        if (result.ok === false) return { ok: false, error: `${key}：${result.error}` }
      }
      const build = runCli(['build', '--all-scopes'])
      return {
        ok: build.ok !== false,
        output: `已更新 ${keys.length} 项设置${build.output ? `\n${build.output}` : ''}`,
        error: build.ok === false ? build.error : undefined,
      }
    },
  }

  function actionHandler(req, res) {
    const fail = (code, message) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: message }))
    }
    if (req.method !== 'POST') return fail(405, '只接受 POST')

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      panelCache = { at: 0, body: '' } // 写操作后让下一次 GET 读到新状态
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result))
    }

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 65536) {
        if (settled) return
        settled = true
        req.destroy?.()
        fail(413, '请求体过大')
      }
    })
    req.on('error', (error) => fail(400, String(error?.message ?? error)))
    req.on('end', () => {
      if (settled) return
      let input
      try {
        input = raw.length === 0 ? {} : JSON.parse(raw)
      } catch {
        return fail(400, '请求体不是合法 JSON')
      }
      const action = typeof input?.action === 'string' ? input.action : ''
      const handler = ACTIONS[action]
      if (handler === undefined) return fail(400, `未知动作 ${action}`)
      try {
        const result = handler(input)
        // 语义判定要等模型，handler 是 async —— 这里必须等它，否则序列化出一个空对象。
        if (result !== null && typeof result?.then === 'function') {
          result.then((value) => finish(value)).catch((error) => {
            log('panel action failed', action, error?.message)
            finish({ ok: false, error: String(error?.message ?? error) })
          })
          return undefined
        }
        return finish(result)
      } catch (error) {
        log('panel action failed', action, error?.message)
        return finish({ ok: false, error: String(error?.message ?? error) })
      }
    })
  }

  // ------------------------------------------------------------ 自动重建画像
  // 老版本只有 CLI 能 build：没人手动跑，profile.json 永远不存在 →
  // 注入恒为空、面板恒为「未生成」，插件看起来完全没生效。
  // 现在每轮落盘后异步补一次 build，三重保险：开关、最小间隔、失败静默。
  let buildInFlight = false
  let lastBuildAt = 0

  function autoBuild() {
    const cfg = config()
    if (cfg.build?.autoBuild === false) return
    if (buildInFlight) return
    const minGap = Number(cfg.build?.autoBuildMinIntervalMs)
    const gap = Number.isFinite(minGap) && minGap >= 0 ? minGap : DEFAULT_CONFIG.build.autoBuildMinIntervalMs
    if (Date.now() - lastBuildAt < gap) return
    buildInFlight = true
    lastBuildAt = Date.now()
    try {
      // --all-scopes：自动重建是「给这个人的画像」，项目级声明也要算进来；
      // 需要按项目看时手动跑 build --scope-id <名字>。
      execFile(process.execPath, [CLI_PATH, 'build', '--all-scopes'], {
        timeout: 20000,
        env: process.env,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        buildInFlight = false
        if (error) {
          log('auto build failed', error.message, String(stderr ?? '').slice(0, 200))
          return
        }
        log('auto build ok', String(stdout ?? '').split('\n')[0])
        panelCache = { at: 0, body: '' } // 新画像立刻反映到设置页
      })
    } catch (error) {
      buildInFlight = false
      log('auto build spawn failed', error?.message)
    }
  }

  // ------------------------------------------------------------ 智能提取画像事实
  // 行为信号只能回答「他怎么干活」，回答不了「他是谁、要什么、不能碰什么」。
  // 真正有价值的条目只能从对话语义里读出来：每轮结束用一次轻量模型调用，把这轮
  // 对话压成若干条候选事实，写进 declarations（高置信）或 pending（待审）。
  // 隐私边界：对话正文只在内存里拼成一次请求，永不落盘；落盘的只有提炼结果。
  const turnText = new WeakMap()
  const sessionRoute = new WeakMap()
  // 面板/轮末没有 session 时用它兜底：最近一次观测到的 provider/model。
  let lastRoute = null
  // 会话 id 缓存：从首条 session 事件里抓，供 provenance 归因用
  const sessionIds = new WeakMap()
  const extracting = new WeakSet()
  const turnCounter = new WeakMap()

  let llmRef
  if (typeof ctx.inject === 'function') {
    try {
      // 'llm' 是宿主模型服务；拿不到就退化成「只有行为信号」，不阻塞任务。
      ctx.inject(['llm'], (inner) => {
        llmRef = inner?.llm
        caps.llm = typeof llmRef?.prepareCall === 'function'
        if (!caps.llm) log('llm service present but has no prepareCall: extraction disabled')
        writeHostCaps()
      })
    } catch (error) {
      log('llm service unavailable', error?.message)
    }
  }
  // 有些老宿主连 ctx.llm 都没有：同步探测一次，让 .host.json 一开始就说清能不能提炼。
  if (hasMethod('llm', 'prepareCall')) caps.llm = true
  const llmService = () => llmRef ?? ctx.llm

  let llmModule
  const dshLlm = async () => {
    if (llmModule !== undefined) return llmModule
    try {
      const ns = await ctx.loader.import('@deepseek-ai/dsh-llm')
      llmModule = ctx.loader.unwrapExports?.(ns) ?? ns
    } catch (error) {
      // 拿不到 dsh-llm 也要能提取：退化成纯文本流，不借用宿主的消息工厂。
      log('dsh-llm unavailable for extract', error?.message)
      llmModule = {}
    }
    return llmModule
  }

  const textOf = (message) => {
    const content = Array.isArray(message?.content) ? message.content : []
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }

  const pushTurnText = (session, who, text) => {
    if (typeof text !== 'string' || text.length === 0) return
    let buffer = turnText.get(session)
    if (buffer === undefined) {
      buffer = []
      turnText.set(session, buffer)
    }
    if (buffer.length >= 40) return // 单轮上限，防长任务把请求撑爆
    buffer.push({ who, text: text.slice(0, 4000) })
  }

  /** request/header 里带着本轮真正用的 provider/model，借它当提取器的路由（零配置）。 */
  const rememberRoute = (session, event) => {
    const header = event?.data?.header ?? event?.data ?? {}
    const config0 = header?.config ?? {}
    if (typeof config0.provider === 'string' && typeof config0.model === 'string') {
      sessionRoute.set(session, { provider: config0.provider, model: config0.model })
      lastRoute = sessionRoute.get(session)
    }
  }

  /**
   * 第二条路由来源：assistant 消息自带 source:{kind:'model',provider,model}。
   * request/header 是 log-only 事件，未必进 session/event 钩子；这条几乎必然能拿到。
   */
  const rememberRouteFromSource = (session, event) => {
    const source = event?.data?.message?.source ?? event?.data?.source
    if (source?.kind === 'model'
      && typeof source.provider === 'string'
      && typeof source.model === 'string') {
      sessionRoute.set(session, { provider: source.provider, model: source.model })
      lastRoute = sessionRoute.get(session)
    }
  }

  const DIMS = new Set(DIMENSION_IDS)

  /**
   * 这条事实是不是只对「这一次/这个项目」成立？
   * 模型偶尔会把项目细节标成 global，这里做一道便宜的兜底：
   * 命中就降级成 project —— project 只在同工作区生效，不会污染全局画像。
   */
  const SESSION_SCOPED = /(本次|这一轮|这轮|当前任务|刚才那|这个插件|这个文件|这个仓库|该文件|上面那个|临时|待会)/

  /** 模型有时会包 Markdown 或加解释，这里做一次宽容解析；解析不出来就是没有事实。 */
  const parseFacts = (raw) => {
    let text = String(raw ?? '').trim()
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence !== null) text = fence[1].trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) text = text.slice(start, end + 1)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return []
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.facts) ? data.facts : []
    const facts = []
    for (const item of list) {
      if (typeof item?.fact !== 'string') continue
      const fact = item.fact.trim().replace(/\s+/g, ' ')
      if (fact.length < 4 || fact.length > 200) continue
      const dim = DIMS.has(item.dim) ? item.dim : 'taste'
      const parsed = Number(item.confidence)
      const confidence = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.6
      const key = typeof item.key === 'string' && item.key.trim().length > 0
        ? item.key.trim().slice(0, 40)
        : undefined
      // 准入：模型说 global 才可能进全局画像；说 project 一律留在这个工作区；
      // 文本里明显带「本次/这个文件」这类词的，即使标 global 也降级。
      const declared = item.scope === 'project' ? 'project' : 'global'
      const scope = declared === 'global' && SESSION_SCOPED.test(fact) ? 'project' : declared
      facts.push({ dim, fact, confidence, key, scope })
    }
    return facts
  }

  /**
   * 会话标识：宿主不同版本暴露的字段不一样，能拿到哪个用哪个，拿不到就不记。
   * 实测（2026-11-17）宿主传入的 session 对象上没有 id —— 真正的 id 在首条
   * `session` 事件里（`data.id`），所以先查钩子抓到的缓存，再退回字段探测。
   */
  const sessionIdOf = (session) => {
    const cached = sessionIds.get(session)
    if (typeof cached === 'string' && cached.length > 0) return cached
    for (const key of ['id', 'sessionId', 'key', 'title']) {
      const value = session?.[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }

  const writeFacts = (facts, minConfidence, requireGlobal = true, origin = {}) => {    let written = 0
    for (const fact of facts) {
      // 「只有可能应用到全局的才录入」：一次性的、只跟这个项目有关的一律不写进画像。
      if (requireGlobal && fact.scope !== 'global') {
        log('fact dropped (project-scoped)', fact.dim, fact.fact.slice(0, 40))
        continue
      }
      const args = [
        CLI_PATH, 'declare',
        '--dim', fact.dim,
        '--fact', fact.fact,
        '--source', 'model',
        '--confidence', String(fact.confidence),
        '--scope', fact.scope === 'project' ? 'project' : 'global',
      ]
      if (fact.key !== undefined) args.push('--key', fact.key)
      // 溯源：记下这一条是从哪个会话、第几轮、用户哪句话里提炼的。
      // 没有它，「这条到底怎么来的」只能靠翻日志；有了它，面板上悬停就能看到原话。
      if (typeof origin.session === 'string' && origin.session.length > 0) args.push('--session', origin.session)
      if (Number.isFinite(origin.turn)) args.push('--turn', String(origin.turn))
      if (typeof origin.excerpt === 'string' && origin.excerpt.length > 0) args.push('--excerpt', origin.excerpt.slice(0, 80))
      // 低置信的先进待审：面板上能看到，但默认不进注入，避免模型猜的东西污染画像。
      if (fact.confidence < minConfidence) args.push('--pending')
      try {
        execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 15000, env: process.env, windowsHide: true })
        written += 1
        log('fact', fact.dim, fact.confidence, fact.fact.slice(0, 40))
      } catch (error) {
        log('declare failed', error?.message)
      }
    }
    return written
  }

  /** 一轮的语义提取。任何失败都只记日志：画像抽取永远不能影响用户的任务。 */
  /**
   * 把画像里已有的条目（dim/key/一句话）提供给提炼器，要求它复用同一个 key。
   * 不这么做的直接后果：同一件事被反复换 key 重述，画像越用越肿
   * ——实测出现过「每个插件只做一件事」与「不同插件职责分离」两条同义偏好并存。
   */
  function existingContext() {
    const profile = readPortrait()
    if (profile === undefined || profile?.dimensions === undefined) return ''
    const rows = []
    for (const [dim, section] of Object.entries(profile.dimensions)) {
      for (const item of section?.items ?? []) {
        if (typeof item?.key !== 'string' || typeof item?.text !== 'string') continue
        rows.push(`- ${dim}/${item.key}：${item.text}`)
      }
    }
    if (rows.length === 0) return ''
    return `已有画像条目（同一件事必须复用这里的 key，文字可更新，key 不要新造）：\n${rows.join('\n')}\n\n`
  }

  async function extractTurn(session) {
    const cfg = config()
    const ex = { ...DEFAULT_CONFIG.extract, ...(cfg.extract ?? {}) }
    if (ex.enabled === false) return
    if (cfg.capture?.turnText === false) return

    const buffer = turnText.get(session) ?? []
    turnText.delete(session)
    const turns = (turnCounter.get(session) ?? 0) + 1
    turnCounter.set(session, turns)
    const every = Number.isFinite(ex.everyTurns) && ex.everyTurns >= 1 ? ex.everyTurns : 1
    if (turns % every !== 0) return
    if (extracting.has(session)) return

    const dialogue = buffer
      .map((item) => `${item.who === 'user' ? '用户' : '助手'}：${item.text}`)
      .join('\n\n')
      .slice(0, ex.maxInputChars)
    if (dialogue.length < ex.minInputChars) return

    // 触发判定（流程第 1 步）：临时任务/一次性问答不提取。
    // 判据是「用户有没有在讲自己」——讲了自己就值得提炼，纯粹让我干活就不必。
    const userSaid = buffer
      .filter((item) => item.who === 'user')
      .map((item) => item.text)
      .join('\n')
    if (ex.skipEphemeralTurns !== false && !worthExtracting(userSaid)) {
      log('skip extract: ephemeral turn')
      return
    }

    const route = sessionRoute.get(session)
      ?? (typeof ex.provider === 'string' && ex.provider.length > 0 && typeof ex.model === 'string' && ex.model.length > 0
        ? { provider: ex.provider, model: ex.model }
        : undefined)
    if (route === undefined) {
      log('extract skipped: no route yet')
      return
    }
    const llm = llmService()
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      log('extract skipped: no llm service')
      return
    }

    extracting.add(session)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number.isFinite(ex.timeoutMs) ? ex.timeoutMs : 45000)
    try {
      const mod = await dshLlm()
      const createUserMessage = mod?.createUserMessage
      const BlockAssembler = mod?.BlockAssembler
      const call = await llm.prepareCall(
        { ...route, maxTokens: ex.maxOutputTokens },
        controller.signal,
      )
      const payload = `${existingContext()}对话片段：\n\n${dialogue}`
      const messages = typeof createUserMessage === 'function'
        ? [createUserMessage({
          content: [{ type: 'text', text: payload }],
          // 用自己的 source.kind 标识这条内部调用（与内置 title 插件同做法），
          // 不冒充 agent-instructions，免得在下游被当成插件注入的"指令"。
          source: { kind: 'dsh-user-profile' },
        })]
        : [{ role: 'user', content: [{ type: 'text', text: payload }] }]
      const options = {
        ...call.config,
        messages,
        system: EXTRACT_SYSTEM,
        purpose: 'user-profile-extract',
        signal: controller.signal,
      }

      let raw = ''
      if (typeof BlockAssembler === 'function') {
        const assembler = new BlockAssembler()
        for await (const chunk of call.stream(options)) assembler.push(chunk)
        raw = assembler.blocks()
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
      } else {
        for await (const chunk of call.stream(options)) {
          if (typeof chunk?.text === 'string') raw += chunk.text
        }
      }

      const facts = parseFacts(raw).slice(0, Number.isFinite(ex.maxFactsPerTurn) ? ex.maxFactsPerTurn : 5)
      if (facts.length === 0) {
        log('extract: nothing reusable this turn')
        return
      }
      const minConfidence = Number.isFinite(ex.autoAcceptConfidence) ? ex.autoAcceptConfidence : 0.7
      // 溯源的三个字段都能缺：拿不到会话 id 就只记时间与原话，不编造。
      const firstUserText = buffer.find((item) => item.who === 'user')?.text ?? ''
      const origin = {
        session: sessionIdOf(session),
        turn: turns,
        excerpt: firstUserText.slice(0, 80),
      }
      if (writeFacts(facts, minConfidence, ex.requireGlobal !== false, origin) === 0) return
      // 立刻重建一次，下一轮 pre-step 就能读到大模型刚提炼出来的条目。
      try {
        execFileSync(process.execPath, [CLI_PATH, 'build', '--all-scopes'], {
          encoding: 'utf8',
          timeout: 20000,
          env: process.env,
          windowsHide: true,
        })
        panelCache = { at: 0, body: '' }
      } catch (error) {
        log('build after extract failed', error?.message)
      }
    } catch (error) {
      log('extract failed', error?.message)
    } finally {
      clearTimeout(timer)
      extracting.delete(session)
    }
  }

  /**
   * 语义合并：字面相似度抓不到的「换了说法讲同一件事」，交给模型判。
   * 判据写在系统提示里，输出严格 JSON；只回灌 same=true 的对，且 keep 取更可信那条。
   */
  const MERGE_SYSTEM = [
    '你在帮助手整理「关于用户」的记忆条目。给你若干对句子，每对是两条已记录的记忆。',
    '判断每对是否在讲同一件关于用户的事实（同一个意思），而不是仅仅涉及同一个话题。',
    '规则：',
    '1. 数字不同（班级、年份、版本、数量）→ 不是同一件事。',
    '2. 一句被另一句基本包含、只是更简略 → 是同一件事。',
    '3. 只是都提到同一领域（都提到界面、都提到插件），但说的是不同要求 → 不是同一件事。',
    '4. 一条是偏好、另一条是禁止/红线 → 不是同一件事。',
    '只输出 JSON，不要解释：{"pairs":[{"i":0,"same":true,"keep":"a","reason":"不超过12字"}]}',
  ].join('\n')

  let mergeJudging = false
  let lastSemanticMergeAt = 0

  const parseJudge = (raw) => {
    const text = String(raw ?? '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    try {
      const data = JSON.parse(text.slice(start, end + 1))
      const list = Array.isArray(data) ? data : (Array.isArray(data?.pairs) ? data.pairs : [])
      return list.filter((item) => item && typeof item.i === 'number' && item.same === true)
    } catch {
      return []
    }
  }

  /** 返回 { pairs, judged, applied } —— 失败只记日志，不抛。 */
  async function semanticMerge(route) {
    const cfg = config()
    if (cfg.build?.autoMergeSemantic === false) return { pairs: 0, judged: 0, applied: 0 }
    if (mergeJudging) return { pairs: 0, judged: 0, applied: 0 }
    let candidates = []
    try {
      const raw = execFileSync(process.execPath, [CLI_PATH, 'dedupe', '--pairs'], {
        encoding: 'utf8',
        timeout: 20000,
        env: process.env,
        windowsHide: true,
      })
      const start = raw.indexOf('{')
      candidates = JSON.parse(raw.slice(start)).pairs ?? []
    } catch (error) {
      log('dedupe --pairs failed', error?.message)
      return { pairs: 0, judged: 0, applied: 0 }
    }
    if (candidates.length === 0) return { pairs: 0, judged: 0, applied: 0 }

    const chosen = route ?? lastRoute
    const llm = llmService()
    if (chosen === undefined || chosen === null || typeof llm?.prepareCall !== 'function') {
      log('semantic merge skipped: no route or llm')
      return { pairs: candidates.length, judged: 0, applied: 0 }
    }

    mergeJudging = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const mod = await dshLlm()
      const createUserMessage = mod?.createUserMessage
      const BlockAssembler = mod?.BlockAssembler
      const call = await llm.prepareCall({ ...chosen, maxTokens: 900 }, controller.signal)
      const lines = candidates.map((pair, index) => `${index}. A：${pair.a.fact}\n   B：${pair.b.fact}`)
      const messages = typeof createUserMessage === 'function'
        ? [createUserMessage({ content: [{ type: 'text', text: lines.join('\n') }], source: { kind: 'agent-instructions', form: 'instructions', changes: [] } })]
        : [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }]
      let raw = ''
      if (typeof BlockAssembler === 'function') {
        const assembler = new BlockAssembler()
        for await (const chunk of call.stream({ ...call.config, messages, system: MERGE_SYSTEM, purpose: 'user-profile-dedupe', signal: controller.signal })) {
          assembler.push(chunk)
        }
        raw = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
      } else {
        for await (const chunk of call.stream({ ...call.config, messages, system: MERGE_SYSTEM, purpose: 'user-profile-dedupe', signal: controller.signal })) {
          if (typeof chunk?.text === 'string') raw += chunk.text
        }
      }
      const verdicts = parseJudge(raw)
      if (verdicts.length === 0) return { pairs: candidates.length, judged: 0, applied: 0 }

      const spec = []
      for (const verdict of verdicts) {
        const pair = candidates[verdict.i]
        if (pair === undefined) continue
        // 模型说留哪条就留哪条；没说或说错就用可信度兜底（高者留）。
        const keepFirst = verdict.keep === 'a' ? true : verdict.keep === 'b' ? false : pair.a.c >= pair.b.c
        spec.push(`${keepFirst ? pair.a.id : pair.b.id}|${keepFirst ? pair.b.id : pair.a.id}`)
      }
      if (spec.length === 0) return { pairs: candidates.length, judged: verdicts.length, applied: 0 }
      try {
        execFileSync(process.execPath, [CLI_PATH, 'dedupe', '--apply-pairs', spec.join(',')], {
          encoding: 'utf8',
          timeout: 30000,
          env: process.env,
          windowsHide: true,
        })
        panelCache = { at: 0, body: '' }
      } catch (error) {
        log('dedupe --apply-pairs failed', error?.message)
        return { pairs: candidates.length, judged: verdicts.length, applied: 0 }
      }
      lastSemanticMergeAt = Date.now()
      return { pairs: candidates.length, judged: verdicts.length, applied: spec.length }
    } catch (error) {
      log('semantic merge failed', error?.message)
      return { pairs: candidates.length, judged: 0, applied: 0 }
    } finally {
      clearTimeout(timer)
      mergeJudging = false
    }
  }

  /** 轮末自动跑一次语义合并：默认 30 分钟最多一次，避免每轮都调模型。 */
  async function autoSemanticMerge(session) {
    const cfg = config()
    if (cfg.build?.autoMergeSemantic === false) return
    const gap = Number.isFinite(cfg.build?.semanticMergeIntervalMs) ? cfg.build.semanticMergeIntervalMs : 1800000
    if (Date.now() - lastSemanticMergeAt < gap) return
    const route = sessionRoute.get(session)
    if (route === undefined) return
    const result = await semanticMerge(route)
    if (result.applied > 0) log('semantic merge applied', result.applied, 'groups')
  }

  /** session -> { tools: Map<string, number>, ok: number, fail: number, steps: number, startedAt: number } */
  const turnStats = new WeakMap()
  /** session -> 需要在本轮 pre-step 注入 */
  const pendingInject = new WeakSet()

  const statsOf = (session) => {
    let stats = turnStats.get(session)
    if (stats === undefined) {
      stats = { tools: new Map(), ok: 0, fail: 0, steps: 0, startedAt: Date.now() }
      turnStats.set(session, stats)
    }
    return stats
  }

  /**
   * 真实事件形状（0.2.2 会话日志实测）：
   *   tool/call   → data = { turn, step, callId, name, arguments }   ← 工具名在这里
   *   tool/result → data = { turn, step, message: { isError, content } } ← 没有工具名
   * 老版本只看 event.tool/event.name，于是全都记成 'unknown'。
   */
  const toolNameOf = (event) => {
    const data = event?.data ?? event ?? {}
    const candidates = [
      data.name,
      data.tool,
      data.toolName,
      data.message?.name,
      event?.name,
      event?.tool,
      event?.toolName,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0 && candidate !== 'unknown') return candidate
    }
    const block = Array.isArray(data.message?.content)
      ? data.message.content.find((item) => item?.type === 'tool-call' && typeof item?.name === 'string')
      : undefined
    return block?.name ?? 'unknown'
  }

  const isError = (event) => {
    const data = event?.data ?? event ?? {}
    return Boolean(
      data.message?.isError
      ?? data.isError
      ?? data.error
      ?? data.result?.isError
      ?? event?.isError,
    )
  }

  /** 落盘一轮的聚合信号；任何异常都吞掉，绝不影响任务。 */
  const flushTurn = (session) => {
    const cfg = config()
    if (cfg.capture?.turnSignals === false) return
    const stats = turnStats.get(session)
    if (stats === undefined) return
    turnStats.delete(session)
    const tools = [...stats.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
    if (tools.length === 0 && stats.steps === 0) return
    try {
      const dir = p('observations')
      mkdirSync(dir, { recursive: true })
      const month = new Date().toISOString().slice(0, 7)
      const record = {
        at: new Date().toISOString(),
        kind: 'turn',
        tools: cfg.capture?.toolNames === false ? [] : tools.map(([tool, count]) => ({ tool, count })),
        steps: stats.steps,
        ok: stats.ok,
        fail: stats.fail,
        durationMs: Date.now() - stats.startedAt,
      }
      appendFileSync(join(dir, `${month}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
      log('turn flushed', record.tools.length, 'tools')
    } catch (error) {
      log('flush failed', error?.message)
    }
  }

  onSafe('session/event', (session, event) => {
    try {
      if (session === undefined) return
      switch (canonicalEventType(event?.type)) {
        case 'session':
          // 首条事件带着真正的会话 id；记下来，provenance 才有得归因。
          if (typeof event?.data?.id === 'string' && event.data.id.length > 0) {
            sessionIds.set(session, event.data.id)
          }
          break
        case 'turn/start':
          pendingInject.add(session)
          turnStats.delete(session)
          turnText.delete(session)
          statsOf(session)
          break
        case 'user/message':
          // 只留文本块：工具调用参数、思考过程不算用户画像素材。
          pushTurnText(session, 'user', textOf(event?.data?.message ?? event?.data))
          break
        case 'assistant/message':
          pushTurnText(session, 'assistant', textOf(event?.data?.message ?? event?.data))
          // 顺带取路由：assistant 消息的 source 里就写着本轮 provider/model。
          rememberRouteFromSource(session, event)
          break
        case 'request/header':
          rememberRoute(session, event)
          break
        case 'tool/call': {
          // 每次调用记一次：名字从 tool/call 取，这是唯一带工具名的事件。
          const stats = statsOf(session)
          const tool = toolNameOf(event)
          stats.steps += 1
          stats.tools.set(tool, (stats.tools.get(tool) ?? 0) + 1)
          break
        }
        case 'tool/result': {
          // 成败看 result：tool/result 带 message.isError。
          const stats = statsOf(session)
          if (isError(event)) stats.fail += 1
          else stats.ok += 1
          break
        }
        case 'turn/end':
          flushTurn(session)
          // 有证据就重建画像：下一轮 pre-step 读到的就是刚 build 的版本。
          // 纯聊天轮（没有工具调用）flushTurn 会提前返回，这里仍尝试一次，
          // 保证首次使用时画像能被建起来而不是一直 missing。
          autoBuild()
          // 语义提取异步跑：不阻塞 turn/end，也不让模型慢/失败拖住用户任务。
          void extractTurn(session).catch((error) => log('extract threw', error?.message))
          // 语义合并也异步：提炼完可能又冒出新的同义条目，间隔节流后顺手并一次。
          void autoSemanticMerge(session).catch((error) => log('semantic merge threw', error?.message))
          break
        default:
          break
      }
    } catch (error) {
      log('session/event failed', error?.message)
    }
  }, 'sessionEvents')

  onSafe('agent/pre-step', async (payload, next) => {
    // 老宿主可能不传 next（当成纯通知），这时按「不拦不改」处理，别把这一步吞掉。
    const nextIsFn = typeof next === 'function'
    diag('pre-step called', 'next=' + nextIsFn, 'step=' + String(payload?.step), 'session=' + (payload?.agent?.session !== undefined))
    const decision = nextIsFn ? await next() : payload?.decision
    try {
      if (decision?.kind === 'reject') return decision
      const agent = payload?.agent
      const session = agent?.session
      const messages = Array.isArray(decision?.messages) ? decision.messages : []

      const cfg = config()
      if (cfg.enabled === false) return decision

      // 画像只在每轮第一个可用步骤注入；turn/start 没来（老会话/resume）时退回 step===1。
      const flagged = session !== undefined && pendingInject.has(session)
      const firstStep = payload?.step === 1
      const injectedBefore = alreadyInjected(messages)
      diag('pre-step gate', 'flagged=' + flagged, 'firstStep=' + firstStep, 'already=' + injectedBefore, 'enabled=' + (cfg.enabled !== false))
      let portraitBlock = ''
      if ((flagged || firstStep) && !injectedBefore) {
        if (flagged) pendingInject.delete(session)
        const portrait = readPortrait()
        const { text: md, source: mdSource } = portraitText()
        const userText = lastUserText(messages)
        const optOut = suppresses(userText, cfg.suppressPatterns)
        if (optOut) {
          if (cfg.inject?.announceSuppressed === false) {
            portraitBlock = ''
          } else {
            portraitBlock = SUPPRESS_NOTICE
            log('suppressed by user request')
          }
        } else if (cfg.inject?.mode === 'on-request') {
          // on-request：不主动叠加任何东西（连规定也要用户开口才注入）。
          portraitBlock = ''
        } else {
          const personalizing = isPersonalizeTurn(userText) && cfg.inject.priorityOnPersonalize !== false
          if (personalizing) log('personalize turn → profile as primary basis')
          // 规定与数据分开：规定永远进，数据有多少带多少（没有就只带规定）。
          let usable = injectable(portrait, md) ? md : ''
          // 相关性检索（流程第 5 步）：只把和本轮有关的条目带进来，记忆不自动扩散。
          // v37：先按当前项目过滤，再做相关性闸门。
          // 面板需要"全部项目"的总览，所以产物仍用 --all-scopes 生成；
          // 但注入给模型的文本不能把别的项目的细节带上。
          if (usable) {
            const curScope = (typeof cfg.scope?.id === 'string' && cfg.scope.id.length > 0)
              ? cfg.scope.id
              : basename(process.cwd())
            // 过滤是"锦上添花"，它出错绝不能让整轮注入消失（v37 第一版就是这么翻车的：
            // basename 忘了导入，抛错被外层 catch 吞掉，画像静默不注入）。
            try {
              const filtered = filterForeignScope(usable, curScope)
              if (filtered.dropped > 0) log('scope filter dropped', filtered.dropped, 'items', 'scope=' + curScope)
              usable = filtered.text
            } catch (error) {
              log('scope filter failed, injecting unfiltered', error?.message)
            }
          }
          if (usable && cfg.inject?.relevantOnly !== false) {
            const gated = relevantOnly(usable, userText)
            if (gated.dropped > 0) log('relevance gate dropped', gated.dropped, 'items')
            usable = gated.text
          }
          if (!usable) log('no profile items, injecting policy only', portrait?.status)
          portraitBlock = buildBlock(usable, portrait, cfg, personalizing)
          log('injected', usable ? mdSource : 'policy-only', `v${portrait?.revision}`)
        }
      }

      const text = portraitBlock
      if (text === '') return decision

      let message
      try {
        const ns = await ctx.loader.import('@deepseek-ai/dsh-llm')
        const mod = ctx.loader.unwrapExports?.(ns) ?? ns
        const factory = mod?.createUserMessage ?? ns?.createUserMessage
        if (typeof factory === 'function') {
          message = factory({
            content: [{ type: 'text', text }],
            source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
          })
        }
      } catch (error) {
        log('dsh-llm unavailable, fallback message', error?.message)
      }
      if (message === undefined) {
        message = {
          id: `dsh-user-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
        }
      }
      diag('pre-step inject', 'chars=' + text.length)
      return { ...decision, messages: [...messages, message] }
    } catch (error) {
      diag('pre-step failed', String(error?.message))
      log('pre-step failed', error?.message)
      return decision
    }
  }, 'preStep')

  // 面板数据走同源 HTTP：client 插件（client.js）只负责渲染，不重复实现排序。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer', 'connection'], (web, connection) => {
        // webServer 有 = 面板可用；connection 没有 = 老宿主没有鉴权服务，
        // 这种情况下接口仍然注册（本机可用），但把降级写进 .host.json，
        // 让人知道「这次没做 cookie 校验」是因为宿主没提供，而不是我忘了。
        caps.webServer = (() => { try { return typeof web?.webServer?.register === 'function' } catch { return false } })()
        caps.connection = (() => { try { return typeof connection?.requestRejection === 'function' } catch { return false } })()
        if (!caps.connection) log('connection service missing: panel route runs without cookie fence')
        writeHostCaps()
        /**
         * 面板里有画像正文，属于会话私有数据：先过 Web 宿主的鉴权闸门
         * （cookie 网关 + Host/Origin fence），未授权的本机进程读不到。
         */
        const reject = (req, res) => {
          try {
            const status = connection?.requestRejection?.(req)
            if (status === undefined) return false
            res.statusCode = status
            res.end()
            return true
          } catch (error) {
            log('requestRejection failed, failing closed', error?.message)
            res.statusCode = 500
            res.end()
            return true
          }
        }
        web.effect(() => web.webServer.register({
          kind: 'exact',
          path: PANEL_ROUTE,
          handler: (req, res) => {
            if (reject(req, res)) return
            panelHandler(req, res)
          },
        }), 'user-profile: panel route')

        // 写操作走独立路径：GET 只读数据，POST 才改数据，语义不混在一条路由里。
        web.effect(() => web.webServer.register({
          kind: 'exact',
          path: ACTION_ROUTE,
          handler: (req, res) => {
            if (reject(req, res)) return
            actionHandler(req, res)
          },
        }), 'user-profile: panel action route')
      })
    } catch (error) {
      // 没有 webServer（纯 CLI / 测试环境）时面板接口缺席，不影响画像注入。
      log('webServer unavailable, panel route skipped', error?.message)
    }
  }

  // 收尾：把这一版宿主的真实能力写下来，并只在有降级时提示一句。
  writeHostCaps()
  diag('apply done', JSON.stringify(caps), 'hostFile=' + hostCapsFile())
  const degraded = []
  if (!caps.sessionEvents) degraded.push('采集（session/event）')
  if (!caps.preStep) degraded.push('画像注入（agent/pre-step）')
  if (!caps.webServer) degraded.push('设置页面板路由（webServer）')
  if (!caps.connection) degraded.push('面板鉴权（connection）')
  if (!caps.llm) degraded.push('智能提取（llm）')
  if (degraded.length > 0) {
    console.log(`[dsh-user-profile] 当前宿主缺少：${degraded.join('、')}；插件已按可用能力降级运行，运行 profile doctor 查看详情。`)
  }
}
