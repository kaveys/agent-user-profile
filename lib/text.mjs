/**
 * 文本判定层（纯函数，无 I/O）。
 * 被两处共用：CLI（build / dedupe / explain）与宿主插件（写入端合并、相关性闸门）。
 * 之前这套数学被抄了两份，改一处漏一处 —— 例如 explain 与真实注入判得不一样。
 */

/** 归一化：只留中英文与数字，压掉标点空白，用于判重。 */
export const normText = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

const charGrams = (s) => {
  if (s.length === 1) return [s]
  const out = []
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2))
  return out
}

/** 字符二元组 Dice 系数：0 完全不同，1 完全相同。中文按字切片足够用。 */
export function similarity(a, b) {
  const x = normText(a)
  const y = normText(b)
  if (x.length === 0 || y.length === 0) return 0
  if (x === y) return 1
  const gx = charGrams(x)
  const gy = charGrams(y)
  const pool = new Map()
  for (const g of gy) pool.set(g, (pool.get(g) ?? 0) + 1)
  let hit = 0
  for (const g of gx) {
    const n = pool.get(g) ?? 0
    if (n > 0) {
      hit += 1
      pool.set(g, n - 1)
    }
  }
  return (2 * hit) / (gx.length + gy.length)
}

/**
 * 覆盖率：短的那条有多少被长的那条「讲到了」。
 * Dice 对长度差敏感（短句套在长句里也只得 0.4），而「一句话被另一句整体包含」恰恰最该合并。
 */
export function coverage(a, b) {
  const x = normText(a)
  const y = normText(b)
  if (x.length === 0 || y.length === 0) return 0
  if (x === y) return 1
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (short.length < 4) return 0
  const pool = new Map()
  for (const g of charGrams(long)) pool.set(g, (pool.get(g) ?? 0) + 1)
  const gs = charGrams(short)
  let hit = 0
  for (const g of gs) {
    const n = pool.get(g) ?? 0
    if (n > 0) {
      hit += 1
      pool.set(g, n - 1)
    }
  }
  return gs.length === 0 ? 0 : hit / gs.length
}

export const similarScore = (a, b) => Math.max(similarity(a, b), coverage(a, b))

/**
 * 去掉主语与情态词后再比一次：「用户要求界面简洁」和「界面要简洁」是同一件事，
 * 但字面 Dice 只有 0.4 左右 —— 中文短句里主语占的比重大，不剥掉永远判不相似。
 */
export const SUBJECT_PREFIX = /^(?:用户|我|本人|该用户|对方)(?:要求|希望|想要|需要|习惯|喜欢|是|在|的|会)?/gu
export const stemText = (text) => normText(text).replace(SUBJECT_PREFIX, '')

/** 综合判定：原句相似 / 一方被另一方包含 / 去主语后相似，取最大。 */
export function mergeScore(a, b) {
  // 数字是有意义的信息（班级、年份、版本、数量）：两句只有数字不同就不再算同义。
  // 否则「并发写入第 1 条」和「第 2 条」、「1 班」和「2 班」会被并成一条。
  const nums = (text) => (String(text ?? '').match(/\d+/g) ?? []).sort().join(',')
  if (nums(a) !== nums(b) && (nums(a).length > 0 || nums(b).length > 0)) return 0
  const direct = similarScore(a, b)
  if (direct >= 1) return 1
  const stemA = stemText(a)
  const stemB = stemText(b)
  if (stemA.length < 4 || stemB.length < 4) return direct
  return Math.max(direct, similarScore(stemA, stemB))
}

/**
 * 相关性用的二元组：按 token 切（中文连写切成双字），供「命中任一片段」判定。
 * 与上面的 normText 路线不同，这里保留 token 边界，命中率更符合直觉。
 */
export function relationBigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
  const out = new Set()
  for (const token of clean.split(' ')) {
    if (token.length === 0) continue
    if (token.length === 1) out.add(token)
    for (let i = 0; i + 1 < token.length; i += 1) out.add(token.slice(i, i + 2))
  }
  return out
}
