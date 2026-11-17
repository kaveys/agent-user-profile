// 某某工作区会话 → 记忆覆盖情况盘点
// 用法：node _sessions.mjs [工作区桶目录名]  —— 省略时自动挑会话最多的那个桶。
// 记忆判定：declarations.jsonl 的 provenance.session 里出现过该会话 id（v15 起才记）。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const pickBucket = () => {
  if (process.argv[2]) return process.argv[2]
  const buckets = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith('--')) : []
  let best = ''
  let most = -1
  for (const name of buckets) {
    let count = 0
    try { count = readdirSync(join(root, name)).length } catch { count = 0 }
    if (count > most) { most = count; best = name }
  }
  return best
}
const BUCKET = pickBucket()
const sessionsRoot = join(root, BUCKET)
const profileHome = join(homedir(), '.dsh', 'user-profile')
// 安装时间：取 config.json 的 birthtime，拿不到就不做「安装前/后」的区分
const PLUGIN_INSTALLED = (() => {
  try { return statSync(join(profileHome, 'config.json')).birthtime } catch { return new Date(0) }
})()

const decls = existsSync(join(profileHome, 'declarations.jsonl'))
  ? readFileSync(join(profileHome, 'declarations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []
const bySession = new Map()
for (const d of decls) {
  const sid = d?.provenance?.session
  if (typeof sid === 'string' && sid) bySession.set(sid, (bySession.get(sid) ?? 0) + 1)
}

function summarise(dir) {
  const file = join(dir, 'session.v4.jsonl.zstd')
  const out = { title: '', turns: 0, tools: 0, ok: false }
  if (!existsSync(file)) return out
  let text
  try { text = zstdDecompressSync(readFileSync(file)).toString('utf8') } catch { return out }
  out.ok = true
  for (const line of text.split('\n')) {
    if (line.includes('"session/title"')) {
      try {
        const event = JSON.parse(line)
        const value = event?.data?.title ?? event?.data?.text ?? ''
        if (typeof value === 'string' && value) out.title = value.replace(/\s+/g, ' ').trim().slice(0, 44)
      } catch { /* ignore */ }
    } else if (line.includes('"turn/start"')) out.turns += 1
    else if (line.includes('"tool/call"')) out.tools += 1
  }
  if (!out.title) {
    // 兜底：第一条用户消息
    for (const line of text.split('\n')) {
      if (!line.includes('"user/message"')) continue
      try {
        const event = JSON.parse(line)
        const content = event?.data?.content ?? event?.data?.message?.content
        const chunk = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : ''
        const clean = String(chunk).replace(/\s+/g, ' ').trim()
        if (clean) { out.title = clean.slice(0, 44); break }
      } catch { /* ignore */ }
    }
  }
  return out
}

const rows = []
for (const name of readdirSync(sessionsRoot)) {
  const dir = join(sessionsRoot, name)
  let stat
  try { stat = statSync(dir) } catch { continue }
  if (!stat.isDirectory()) continue
  const file = join(dir, 'session.v4.jsonl.zstd')
  const bytes = existsSync(file) ? statSync(file).size : 0
  const mtime = existsSync(file) ? statSync(file).mtime : stat.mtime
  const id = name.replace(/^session-/, '')
  const info = bytes > 0 ? summarise(dir) : { title: '', turns: 0, tools: 0, ok: false }
  rows.push({ id, name, bytes, mtime, memory: bySession.get(id) ?? 0, ...info })
}
rows.sort((a, b) => b.mtime - a.mtime)

const substantive = rows.filter((r) => r.turns > 0)
const noMemory = substantive.filter((r) => r.memory === 0)
const beforeInstall = noMemory.filter((r) => r.mtime < PLUGIN_INSTALLED)
const afterInstall = noMemory.filter((r) => r.mtime >= PLUGIN_INSTALLED)

console.log(`会话 ${rows.length} 个｜有实际对话 ${substantive.length} 个｜声明里能归因到会话的 ${bySession.size} 个`)
console.log(`无记忆：${noMemory.length} 个（安装前 ${beforeInstall.length}，安装后 ${afterInstall.length}）`)
console.log('\n=== 安装后仍无记忆（最该补）===')
for (const r of afterInstall) {
  console.log(`${r.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${String(r.turns).padStart(2)} 轮  ${String(r.tools).padStart(3)} 工具  ${String(Math.round(r.bytes / 1024)).padStart(5)} KB  ${r.title || '(无标题)'}  [${r.id.slice(0, 8)}]`)
}
console.log('\n=== 安装前的老会话（插件不在，结构性无记忆，前 20 条）===')
for (const r of beforeInstall.slice(0, 20)) {
  console.log(`${r.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${String(r.turns).padStart(2)} 轮  ${r.title || '(无标题)'}  [${r.id.slice(0, 8)}]`)
}
console.log(`\n（安装前共 ${beforeInstall.length} 个，此处只列最近 20 个）`)
