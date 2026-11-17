# v26 — 判定逻辑只有一份（去重、去屎山）

一句话：把散在 `index.js` 与 `bin/profile.mjs` 里的同一套判定（文本相似、相关性闸门）抽成两个纯函数模块，
顺手修掉「同一个问题两边答案不同」的真 bug。**行为按原样保留**，只是不再有第二份实现。

## 1. 为什么要动

第九轮排查（`tests/audit-9.mjs`）抓到：同一句话，`profile explain` 说「带入 1–2 条」，真实注入却带进 6 条。

原因不是算法错，而是**算法有两份**：

| 位置 | 判据 | 后果 |
| --- | --- | --- |
| `bin/profile.mjs` `relevanceOf()` | 命中数 ÷ 查询二元组数 ≥ 0.12 | 长条目吃亏，说「不相关」 |
| `index.js` `relevantOnly()` | 命中任一片段 + 权重保底 | 实际带进来了 |

两处只要有一处改了阈值或补了保底，另一边立刻开始撒谎。这类 bug 不会崩、只会让人不信任工具。

## 2. 新结构

```
lib/text.mjs        纯数学：normText / similarity / coverage / similarScore / stemText / mergeScore / relationBigrams
lib/relevance.mjs   纯判定：weightOfLine / floorFor / decideCarried / relevantOnly
```

- `lib/*` 不碰文件系统、不读环境（唯一例外：`DSH_PROFILE_MIN_KEEP` 作为保底上限的兜底），可直接单元测试。
- `index.js`：删掉本地 `bigrams()`、`weightOfLine()`、`relevantOnly()`（约 110 行），改为 `import { relevantOnly } from './lib/relevance.mjs'`。
- `bin/profile.mjs`：删掉本地 `normText/similarity/coverage/similarScore/SUBJECT_PREFIX/stemText/mergeScore`（约 84 行）与 `bigramsOf/relevanceOf`（约 27 行），改为两条 import。
- `cmdExplain` 改用 `decideCarried`：现在它和注入**调同一个函数**，说「带入 19 条」时真的就是 19 条。

净减约 220 行，且以后只改一处。

## 3. 顺带修掉的两个真缺陷

1. **`explain` 与注入结论不一致**（上面那个）——修复后 `_audit9` A 段三条查询全部对齐；
   `explain --json` 新增 `filled`、`floor` 字段，调用方能分清「因为命中」还是「因为保底」。
2. **空库 `dedupe --pairs` 不给 JSON**：原来打印「只有 0 条声明，没什么可合并的」并退出 0，
   机器调用方（模型/`profile_dedupe`）只能解析失败。现在 `--pairs` 无论有没有数据都输出
   `{"count":0,"pairs":[]}`；人类可读模式保持原文案。

## 4. 行为核对（没有偷偷改语义）

- `mergeScore('用户要求界面简洁，不要花哨动画', '界面要简洁，别整那些花哨的动画效果')` = **0.44**（与重构前一致）。
- 保底条数 `floorFor(total, minKeep)`：`min(12, max(2, ceil(可筛数 × 0.6)))`，红线段不计入。
- `DSH_PROFILE_MIN_KEEP` 仍然是「上限」而不是「目标」：写坏（`不是数字`）退回 12，写 `3` 就只补到 3 条。
- 注入块的段落顺序、`## 保底带入（本轮字面无关，按权重补足）`、尾部「另有 N 条…未带入」全部保持原样。

## 5. 测试

| 套件 | 结果 |
| --- | --- |
| `tests/selftest.mjs` | 全部通过 |
| `tests/audit-1.mjs` | 33/33 |
| `tests/audit-2.mjs` | 34/34 |
| `tests/audit-3.mjs` | 51/51 |
| `tests/audit-4.mjs` | 全部通过 |
| `tests/audit-5.mjs` | 31/31（D4 改为「挡掉或标为保底带入」，与 v25.1 的保底语义一致） |
| `tests/audit-6.mjs` | 25/25 |
| `tests/audit-7.mjs` | 25/25 |
| `tests/audit-8.mjs` | 27/27 |
| `tests/audit-9.mjs` | 19/19（B 段按「保底条数」计数，不再把红线段算进去） |
| `tests/render.mjs` / `tests/compat.mjs` / `_e2e --cli-only` / `verify-install` | 全部通过 |

## 6. 生效方式

- `index.js` 改动 → **重启 dsh** 生效。
- `bin/profile.mjs`、`lib/*` 改动 → 立即生效（每次命令现起进程）。
- `client.js` 未改。

## 7. 仍未做

- `lib/text.mjs` 只有 CLI 与插件两个调用方，没有独立单测文件（现在由 `_audit8` / `_audit9` 间接覆盖）。
- `explain` 的文本版仍逐条打印前 40 条，条目上千时会很长（`--json` 不受影响）。
- `relevance.mjs` 的相关性仍是「二元组命中」，没有权重衰减（语义相关性由 v25 的模型判定另走一条路）。
