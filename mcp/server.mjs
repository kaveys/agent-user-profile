#!/usr/bin/env node
/**
 * agent-user-profile 的 MCP 服务器（stdio，无第三方依赖）。
 *
 * 为什么要它：核心存储层（bin/profile.mjs）本来就是纯 CLI、不依赖 DSH，
 * 但别的宿主（Claude Code、Cursor、任何支持 MCP 的客户端）只认 MCP。
 * 包一层 stdio，就能让同一份画像跨宿主使用 —— 数据仍然只有一个目录。
 *
 * 协议要点（MCP 2024-11-05）：
 *   - 传输：stdin/stdout 上按行分隔的 JSON-RPC 2.0；**stdout 只允许出现协议消息**，
 *     任何日志都必须走 stderr，否则客户端会解析失败。
 *   - 生命周期：initialize → notifications/initialized → tools/list、tools/call…
 *   - 结果形状：{ content: [{ type: 'text', text }] }，出错用 isError: true。
 *
 * 十四个工具全部是「参数 → 调 CLI → 回文本」的薄封装：不重复实现业务逻辑，
 * 也就不存在「MCP 版和 CLI 版行为不一致」这种经典毛病。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'profile.mjs')
const HOME = process.env.DSH_USER_PROFILE_HOME || join(homedir(), '.dsh', 'user-profile')
const SERVER_INFO = { name: 'agent-user-profile', version: '0.4.0' }
const PROTOCOL_FALLBACK = '2024-11-05'

const log = (message) => process.stderr.write(`[user-profile-mcp] ${message}\n`)

/** 调 CLI 并把 stdout/stderr 合成一段文本；退出码非 0 时标记为错误。 */
function runCli(args, { timeoutMs = 20000 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
    windowsHide: true,
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const text = [stdout, stderr].filter(Boolean).join('\n') || '(没有输出)'
  return { ok: result.status === 0, text }
}

const okText = (text) => ({ content: [{ type: 'text', text }] })
const errText = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * 工具清单。
 * description 写的是「什么时候该用它」，不是「它是什么」——模型是靠这句话决定调不调的。
 */
const TOOLS = [
  {
    name: 'profile_get',
    description: '读取当前用户画像（完整 Markdown）。任务开始前想知道「这个人是谁、有什么红线与偏好」时用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'profile_status',
    description: '看画像健康度：版本、条目数、待审候选、注入正文长度、隐私模式、配置告警。排查「画像为什么没生效」先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'profile_search',
    description: '在本机画像条目里按关键词检索（不区分大小写，匹配内容与 key），返回命中的条目 JSON。想确认某事是否已经记过用它。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，例如「界面」「验证」「色彩」' },
        dim: { type: 'string', description: '只看某个大类（可选）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'profile_declare',
    description: '记下一条关于用户的、跨任务仍成立的长期偏好或红线。只记「换个任务还成立而且会改变下次做法」的事；本次任务细节、文件路径、端口、一次性要求不要记。',
    inputSchema: {
      type: 'object',
      properties: {
        dim: {
          type: 'string',
          description: '大类：identity / work / skills / habits / interests / taste / goals / social / constraints / communication',
        },
        fact: { type: 'string', description: '一句话，主语是「用户」，例如「用户要求界面文案面向用户，不暴露内部路径」' },
        key: { type: 'string', description: '稳定的小写英文 key（可选），例如 taste.ui' },
        confidence: { type: 'number', description: '0..1：用户明说 0.9、反复出现 0.6、只出现一次 0.45' },
        core: { type: 'boolean', description: '是否红线（必进注入块）' },
        pending: { type: 'boolean', description: '只进待审候选，不直接入画像' },
      },
      required: ['dim', 'fact'],
    },
  },
  {
    name: 'profile_forget',
    description: '删除画像条目。按 id 删单条，按 key 或 dim 批量删，或 --all 清空。删除前会自动留快照，可恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id（profile_search 或面板可见）' },
        key: { type: 'string', description: '按 key 删' },
        dim: { type: 'string', description: '按大类删' },
        all: { type: 'boolean', description: '清空所有条目' },
      },
    },
  },
  {
    name: 'profile_retire',
    description: '软失效：让条目退出画像，但记录与来源都留着，随时可以恢复。用户说「这条先别用了」时用它；真要抹掉才用 profile_forget。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id' },
        key: { type: 'string', description: '按 key 失效' },
        reason: { type: 'string', description: '为什么先放下（可留空）' },
        undo: { type: 'boolean', description: 'true = 恢复（unretire）；默认 false = 失效' },
      },
    },
  },
  {
    name: 'profile_pin',
    description: '置顶/取消置顶：置顶的条目每轮都会注入，不受相关性筛选影响。适合「每次都要知道的硬偏好」。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id' },
        key: { type: 'string', description: '按 key 置顶' },
        unpin: { type: 'boolean', description: 'true = 取消置顶' },
      },
    },
  },
  {
    name: 'profile_set_weight',
    description: '调整某条画像的权重（0..1）。用户说「这条更重要 / 这条不太对」时用它，而不是删了重记。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, weight: { type: 'number', description: '0..1' } },
      required: ['id', 'weight'],
    },
  },
  {
    name: 'profile_review',
    description: '处理待审候选（模型提炼出来、置信度不够高的事实）。accept 采纳进画像，reject 丢弃。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'accept', 'reject'] },
        target: { type: 'string', description: '条目 id 或 all' },
      },
      required: ['action'],
    },
  },
  {
    name: 'profile_validate',
    description: '体检：逐条检查画像条目是否「绝对有效」（结构、维度、置信度、是否本次任务细节）。只报告，不改数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'profile_ingest',
    description: '把别的 AI 的「你掌握了我什么」答复整段贴进来：逐条切分、按大类归类、自动定权重。默认只预览，apply=true 才写入。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '整段答复原文' },
        source: { type: 'string', description: '来源工具名，例如 ChatGPT / 豆包（写进溯源）' },
        apply: { type: 'boolean', description: 'true 才真正写入；默认 false 只返回分类与权重预览' },
      },
      required: ['text'],
    },
  },
  {
    name: 'profile_dedupe',
    description: '主动合并相似条目：找出「换了说法讲同一件事」的几条，并成一条（保留信息最全的正文，其余原文进 mergedFrom）。默认只预览，apply=true 才落库。',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: 'true 才真正合并；默认 false 只列出将要合并的分组' },
        threshold: { type: 'number', description: '同大类判定阈值，默认 0.35（实测同义改写 ≥0.38，不相关 ≤0.14）' },
      },
    },
  },
  {
    name: 'profile_backup',
    description: '备份画像。dry-run 只算体积，out 导出到本地目录，upload 推到已配置的 WebDAV。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['dry-run', 'out', 'upload', 'list'], description: '默认 dry-run' },
        dir: { type: 'string', description: 'mode=out 时的本地目录' },
      },
    },
  },
  {
    name: 'profile_set',
    description: '改一处配置（如 inject.maxChars、inject.topK、backup.webdav.url）。非法值会被拒绝并说明可用范围。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
    },
  },
]

function readDeclarations() {
  const file = join(HOME, 'declarations.jsonl')
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // 坏行由 CLI 的 validate 负责处理，这里只跳过
    }
  }
  return out
}

function callTool(name, args = {}) {
  const asText = (value) => (value === undefined ? [] : [String(value)])

  if (name === 'profile_get') {
    const show = runCli(['show'])
    if (!show.ok) return errText(show.text)
    return okText(show.text)
  }

  if (name === 'profile_status') {
    const status = runCli(['status'])
    return status.ok ? okText(status.text) : errText(status.text)
  }

  if (name === 'profile_search') {
    const query = String(args.query ?? '').trim()
    if (query.length === 0) return errText('query 不能为空')
    const needle = query.toLowerCase()
    const dim = typeof args.dim === 'string' && args.dim.length > 0 ? args.dim : undefined
    const hits = readDeclarations().filter((record) => {
      if (dim !== undefined && record?.dim !== dim) return false
      const haystack = `${record?.fact ?? ''} ${record?.key ?? ''}`.toLowerCase()
      return haystack.includes(needle)
    })
    if (hits.length === 0) return okText(`没有匹配「${query}」的条目。`)
    const lines = hits.map(
      (record) => `- ${record.id} [${record.dim} ${record.confidence ?? '?'}] ${record.fact}`,
    )
    return okText(`${hits.length} 条命中：\n${lines.join('\n')}`)
  }

  if (name === 'profile_declare') {
    const dim = String(args.dim ?? '').trim()
    const fact = String(args.fact ?? '').trim()
    if (dim.length === 0 || fact.length === 0) return errText('dim 与 fact 都必填')
    const flags = ['declare', '--dim', dim, '--fact', fact]
    if (args.key) flags.push('--key', String(args.key))
    if (Number.isFinite(Number(args.confidence))) flags.push('--confidence', String(Number(args.confidence)))
    if (args.core === true) flags.push('--core')
    if (args.pending === true) flags.push('--pending')
    flags.push('--source', 'model')
    const result = runCli(flags)
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_forget') {
    const flags = ['forget']
    if (args.all === true) flags.push('--all')
    else if (args.id) flags.push('--id', String(args.id))
    else if (args.key) flags.push('--key', String(args.key))
    else if (args.dim) flags.push('--dim', String(args.dim))
    else return errText('至少给一个条件：id / key / dim / all')
    const result = runCli(flags)
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_retire') {
    const flags = [args.undo === true ? 'unretire' : 'retire']
    if (args.id) flags.push('--id', String(args.id))
    else if (args.key) flags.push('--key', String(args.key))
    else return errText('至少给一个条件：id / key')
    if (args.undo !== true && typeof args.reason === 'string' && args.reason.trim().length > 0) {
      flags.push('--reason', args.reason.trim())
    }
    const result = runCli(flags)
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_pin') {
    const flags = [args.unpin === true ? 'unpin' : 'pin']
    if (args.id) flags.push('--id', String(args.id))
    else if (args.key) flags.push('--key', String(args.key))
    else return errText('至少给一个条件：id / key')
    const result = runCli(flags)
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_set_weight') {
    const id = String(args.id ?? '').trim()
    if (id.length === 0) return errText('id 必填')
    const weight = Number(args.weight)
    if (!Number.isFinite(weight)) return errText('weight 需要数字')
    const result = runCli(['edit', '--id', id, '--weight', String(weight)])
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_review') {
    const action = String(args.action ?? 'list')
    if (action === 'list') {
      const result = runCli(['review'])
      return result.ok ? okText(result.text) : errText(result.text)
    }
    const target = String(args.target ?? 'all')
    const result = runCli(['review', action === 'accept' ? '--accept' : '--reject', target])
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_validate') {
    const result = runCli(['validate'])
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_ingest') {
    const text = String(args.text ?? '')
    if (text.trim().length === 0) return errText('缺少 text')
    const source = String(args.source ?? 'other-ai').slice(0, 40)
    const file = join(tmpdir(), `agent-user-profile-ingest-${Date.now()}-${process.pid}.txt`)
    writeFileSync(file, text, 'utf8')
    try {
      const argv = ['ingest', '--file', file, '--source', source]
      if (args.apply === true) argv.push('--apply')
      const result = runCli(argv, { timeoutMs: 30000 })
      return result.ok ? okText(result.text) : errText(result.text)
    } finally {
      try { unlinkSync(file) } catch { /* 临时文件清不掉不影响结果 */ }
    }
  }

  if (name === 'profile_dedupe') {
    const argv = ['dedupe']
    if (args.apply === true) argv.push('--apply')
    if (Number.isFinite(Number(args.threshold))) argv.push('--threshold', String(Number(args.threshold)))
    const result = runCli(argv, { timeoutMs: 30000 })
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_backup') {
    const mode = String(args.mode ?? 'dry-run')
    if (mode === 'list') {
      const result = runCli(['backup', '--list'], { timeoutMs: 40000 })
      return result.ok ? okText(result.text) : errText(result.text)
    }
    if (mode === 'out') {
      if (!args.dir) return errText('mode=out 需要 dir')
      const result = runCli(['backup', '--out', String(args.dir)])
      return result.ok ? okText(result.text) : errText(result.text)
    }
    if (mode === 'upload') {
      const result = runCli(['backup'], { timeoutMs: 60000 })
      return result.ok ? okText(result.text) : errText(result.text)
    }
    const result = runCli(['backup', '--dry-run'], { timeoutMs: 40000 })
    return result.ok ? okText(result.text) : errText(result.text)
  }

  if (name === 'profile_set') {
    const key = String(args.key ?? '').trim()
    if (key.length === 0) return errText('key 必填')
    const result = runCli(['set', key, String(args.value ?? '')])
    return result.ok ? okText(result.text) : errText(result.text)
  }

  return errText(`未知工具：${name}`)
}

function listResources() {
  if (!existsSync(HOME)) return []
  const resources = [
    { uri: 'user-profile://portrait', name: '用户画像（注入用的三段式文本）', mimeType: 'text/markdown' },
    { uri: 'user-profile://declarations', name: '声明型条目（JSONL）', mimeType: 'application/x-ndjson' },
  ]
  return resources
}

function readResource(uri) {
  if (uri === 'user-profile://portrait') {
    for (const name of ['inject.md', 'profile.md']) {
      const file = join(HOME, name)
      if (existsSync(file)) return readFileSync(file, 'utf8')
    }
    return '（还没有生成画像：先用 profile_declare 记一条，或运行 CLI 的 build）'
  }
  if (uri === 'user-profile://declarations') {
    const file = join(HOME, 'declarations.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  throw new Error(`未知资源：${uri}`)
}

function handle(request) {
  const { id, method, params } = request
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return reply({
      protocolVersion: typeof requested === 'string' && requested.length > 0 ? requested : PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
      serverInfo: SERVER_INFO,
      instructions:
        '这是用户的长期画像。任务开始前调 profile_get 了解这个人；' +
        '只有「换个任务仍成立、且会改变下次做法」的事才用 profile_declare 记录，' +
        '本次任务细节、文件路径、端口号、一次性要求一律不要记。',
    })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (typeof name !== 'string' || name.length === 0) return fail(-32602, 'tools/call 需要 name')
    // 未知工具要明确报错：早前会掉到 callTool 的末尾返回 undefined，
    // 于是 stdout 上出现一个 {"result":{}} —— 调用方以为成功，实际上什么都没做。
    if (!TOOLS.some((tool) => tool?.name === name)) {
      return fail(-32602, `未知工具：${name}`)
    }
    try {
      return reply(callTool(name, args))
    } catch (error) {
      log(`tool ${name} failed: ${error?.message ?? error}`)
      return reply(errText(`工具执行失败：${error?.message ?? error}`))
    }
  }
  if (method === 'resources/list') return reply({ resources: listResources() })
  if (method === 'resources/read') {
    const uri = params?.uri
    try {
      const text = readResource(String(uri))
      return reply({ contents: [{ uri, mimeType: 'text/markdown', text }] })
    } catch (error) {
      return fail(-32602, error.message)
    }
  }
  if (method === 'resources/templates/list') return reply({ resourceTemplates: [] })
  if (method === 'prompts/list') return reply({ prompts: [] })
  // 通知（没有 id）不需要回复
  if (id === undefined || method?.startsWith('notifications/')) return null
  return fail(-32601, `未知方法：${method}`)
}

function send(message) {
  if (message === null || message === undefined) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function main() {
  if (!existsSync(CLI)) {
    log(`找不到 CLI：${CLI}（画像服务器装错目录了）`)
    process.exit(1)
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let request
    try {
      request = JSON.parse(trimmed)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
      return
    }
    try {
      send(handle(request))
    } catch (error) {
      log(`handler crashed: ${error?.message ?? error}`)
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } })
    }
  })
  rl.on('close', () => process.exit(0))
  log(`ready · CLI=${CLI} · HOME=${HOME} · ${readDeclarations().length} 条声明`)
}

main()


