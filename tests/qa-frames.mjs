// qa-frames.mjs — 检查每场 PNG 的内容包围盒是否贴边（裁切）以及底部字幕带是否压到正文
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = process.argv[2] ?? 'scripts/trailer-build'
const ff = process.env.FFMPEG || 'ffmpeg'
const SW = 480, SH = 270 // 缩略分辨率：1/4 采样，够看边距，raw 只有 380KB
const SX = 4, SY = 4
const W = SW, H = SH
const BG = 30 // 背景亮度阈值

const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
if (files.length === 0) { console.error('没有找到 PNG'); process.exit(1) }

for (const f of files) {
  const buf = execFileSync(ff, ['-v', 'error', '-i', join(dir, f), '-vf', 'scale=480:270', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-', '-frames:v', '1'])
  let minX = W, minY = H, maxX = -1, maxY = -1
  const rowHit = new Uint8Array(H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const lum = (buf[i] * 299 + buf[i + 1] * 587 + buf[i + 2] * 114) / 1000
      if (lum > BG) {
        rowHit[y] = 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  // 字幕带（设计坐标 y>=600 → 像素 900）是整幅铺底，单独判断正文是否越过 900
  let textBottom = -1
  for (let y = 0; y < 225; y++) if (rowHit[y]) textBottom = y
  const margin = 6
  const issues = []
  if (minX < margin) issues.push(`左边距 ${minX}px`)
  if (maxX > W - margin) issues.push(`右边距 ${W - maxX}×${SX}px`)
  if (minY < margin) issues.push(`上边距 ${minY}px`)
  if (textBottom > 220) issues.push(`正文下缘 ${textBottom}px 逼近字幕带`)
  const verdict = issues.length === 0 ? 'OK' : 'CHECK ' + issues.join(' / ')
  console.log(`${f.padEnd(20)} bbox x ${minX*SX}..${maxX*SX}  y ${minY*SY}..${maxY*SY}  正文下缘 ${textBottom*SY}  ${verdict}`)
}

