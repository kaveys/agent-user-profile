/**
 * 相关性闸门（纯函数，无 I/O）。
 * 一套判定，三处共用：宿主注入（index.js）、CLI explain（预览）、以及将来的面板视图。
 * 之前 explain 自己算了一套（按比例 ≥0.12），注入按「命中任一片段」，两边结论相反 ——
 * 这正是本文件存在的理由：判据只能有一份。
 */
import { relationBigrams } from './text.mjs'

export const DEFAULT_MIN_KEEP = 12
export const REDLINE_SECTION = /红线|硬要求/
/** 置顶段：用户亲手钉住的条目，和红线一样「永远带走」，不参与相关性筛选。 */
export const PINNED_SECTION = /钉住|每轮必带/

/** 从 `- [约束与红线 0.9·已确认] …` 里取权重；取不到按 0 处理（排到最后）。 */
export function weightOfLine(line) {
  const m = /- \[[^\]]*?([0-9]+(?:\.[0-9]+)?)·/.exec(String(line ?? ''))
  return m ? Number(m[1]) : 0
}

/**
 * 保底条数：只对「可筛条目」（非红线段）算。
 * 线索少的轮次（「继续」「对的」）不能把画像清空 —— 那是画像最该起作用的时候。
 * 条数少时按比例保底，保证闸门仍然真的在筛（6 条保 4 条、25 条保 12 条）。
 */
export function floorFor(filterableTotal, minKeep = DEFAULT_MIN_KEEP) {
  const limit = Number.isFinite(Number(minKeep)) && Number(minKeep) > 0 ? Number(minKeep) : DEFAULT_MIN_KEEP
  return Math.min(limit, Math.max(2, Math.ceil(filterableTotal * 0.6)))
}

const toQuery = (query) => (query instanceof Set ? query : relationBigrams(query))

const shares = (text, query) => {
  if (query.size === 0) return false
  for (const gram of relationBigrams(text)) if (query.has(gram)) return true
  return false
}

/**
 * 唯一判定：返回哪些进、哪些靠保底进、哪些被挡。
 * items: [{ text, weight, redline }]，顺序即展示顺序。
 */
export function decideCarried(items, queryText, opts = {}) {
  // 环境变量兜底：DSH_PROFILE_MIN_KEEP 写坏时退回默认，不能让闸门失效。
  const minKeep = opts.minKeep ?? process.env.DSH_PROFILE_MIN_KEEP ?? DEFAULT_MIN_KEEP
  const query = toQuery(queryText)
  const all = Array.isArray(items) ? items : []
  const redline = all.filter((item) => item.redline === true)
  const rest = all.filter((item) => item.redline !== true)
  if (query.size === 0) {
    return { carried: all, hit: rest, filled: [], dropped: [], floor: 0 }
  }
  const hit = rest.filter((item) => shares(item.text, query))
  const spare = rest.filter((item) => !hit.includes(item))
  const floor = floorFor(rest.length, minKeep)
  const need = Math.max(0, Math.min(floor - hit.length, spare.length))
  const filled = spare
    .map((item, index) => ({ item, index, weight: Number(item.weight ?? 0) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, need)
    .map((row) => row.item)
  const dropped = spare.filter((item) => !filled.includes(item))
  return { carried: [...redline, ...hit, ...filled], hit, filled, dropped, floor }
}

/**
 * 注入用的 Markdown 视图：按行扫描，用 decideCarried 决定去留，再拼回去。
 * 保留原有分段顺序与标题；被保底带回的条目单列一段，让模型分得清「因为相关」还是「因为重要」。
 */
export function relevantOnly(md, userText, opts = {}) {
  const raw = typeof md === 'string' ? md : ''
  const query = toQuery(userText)
  if (raw.trim().length === 0 || query.size === 0) return { text: raw, dropped: 0, filled: 0 }

  const lines = raw.split('\n')
  const entries = []
  let inRedline = false
  let inPinned = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inRedline = REDLINE_SECTION.test(line)
      inPinned = PINNED_SECTION.test(line)
      continue
    }
    if (!line.startsWith('- [')) continue
    entries.push({ line, text: line, weight: weightOfLine(line), redline: inRedline || inPinned })
  }
  if (entries.length === 0) return { text: raw, dropped: 0, filled: 0 }

  const verdict = decideCarried(entries, query, opts)
  const keptLines = new Set(verdict.carried.filter((e) => !verdict.filled.includes(e)).map((e) => e.line))

  // 标题只在「这个分段确实有条目被留下」时才补一次。
  // 之前在这里 flush 时又 push 了一遍，导致注入块里每个分段标题都出现两次（空标题挂在下面）。
  const kept = []
  let currentHeader = ''
  let headerUsed = false

  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentHeader = line
      headerUsed = false
      continue
    }
    if (!line.startsWith('- [')) {
      // 标题、`> 生成于…`、空行、尾注：原样保留（丢了下游就不知道这是哪一版）
      if (/^\s*$/.test(line)) kept.push(line)
      else kept.push(line)
      continue
    }
    if (keptLines.has(line)) {
      if (currentHeader && !headerUsed) { kept.push(currentHeader); headerUsed = true }
      kept.push(line)
    }
  }

  const filled = verdict.filled
  if (filled.length > 0) {
    kept.push('', '## 保底带入（本轮字面无关，按权重补足）')
    for (const item of filled) kept.push(item.line)
  }

  const dropped = verdict.dropped.length
  let body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  if (dropped > 0) body += `\n\n（另有 ${dropped} 条与本次无关的条目未带入；需要时可让我按关键词查。）`
  return { text: `${body}\n`, dropped, filled: filled.length }
}
