# v17：按「六步记忆流水线」重排（触发 → 抽取 → 分区 → 加密 → 相关 → 增删改）

这一版不是加功能，而是**换主线**：原来按「采集 / 注入」两件事组织，现在按一条记忆流水线组织，
每一步都能单独关掉、单独观察。

## 六步与实现对照

| 步骤 | 规则原文要求 | 现在的实现 | 开关 |
| --- | --- | --- | --- |
| 1 触发判定层 | 临时任务/闲聊不存；自我陈述/偏好/主动记住才存；敏感隐私直接拦截 | `worthExtracting()`：命中「我是/我的/我习惯/以后/记住/一律…」就提炼；纯干活（翻译/做题/查报错/查参数）跳过。隐私在写入前用 `blockedPrivacy()` 拦截，**打码也不收**——记着「他有身份证号」本身就没价值 | `extract.skipEphemeralTurns`；`declare --force` 可越过拦截 |
| 2 实体抽取 + 语义归一 | 不存原文，只存结构化键值 | 抽取仍然走 LLM（`EXTRACT_SYSTEM` 的三道检查）产出 `{dim,key,fact,confidence,scope}`；落盘只有这一行结构化记录，对话正文永不落盘。同义合并由 `similarity + dedupe` 完成，判为同义的进 `history` 并记 `conflicts.status='merged'` | `extract.enabled`、`build.dedupe`、`build.similarityThreshold` |
| 3 冲突校验 + 三类分区 | 分 `user_profile` / `user_preference` / `user_social_network` | 十条大类各自归口到一个分区：身份/职业/能力/目标/红线 → `user_profile`；审美/沟通/习惯/兴趣 → `user_preference`；社交 → `user_social_network`。`panel` 输出 `partitions` 汇总，每条 item 带 `partition` 字段 | 分区是派生映射，无需配置 |
| 4 加密持久化 | 加密存储 | 本机磁盘由操作系统账户隔离；**真正会离开本机的只有备份包**，所以 `backup` 上传路径默认加密，`backup --out --encrypt` 也可加密导出。AES-256-GCM + scrypt 派生，口令来自 `--passphrase` / `DSH_PROFILE_PASSPHRASE` / `secrets.json`。新增 `unseal` 解密回 JSON | `--encrypt`；上传默认开 |
| 5 轻量相关性调用 | 按需检索，不自动扩散、不主动暴露 | 注入前 `relevantOnly()` 按字符二元组重合度过滤：红线段永远带入，其余只带本轮相关的；被挡掉的条数写成「（另有 N 条与本次无关的条目未带入）」。判不出来（无文字/全不匹配）时全带 | `inject.relevantOnly` |
| 6 主动增删改 | 只有用户指令才删除 | 本来就是用户驱动：`declare/edit/merge/forget/review/import/dims`；删除前自动留 `snapshots/declarations-*.jsonl`，面板「恢复点」可整批还原 | — |

## 这一版顺手修掉的真 bug

- **`maxChars: 0` 把整份画像截没了**：`buildBlock` 把新约定的「0 = 不设上限」当成「预算 0 字」，
  注入块只剩一行「…（画像正文已按 maxChars 截断）」。由 `_selftest` 的「默认叠加：注入画像」用例抓到，
  修法是把 `limit <= 0` 直接视为不限。
- **注入块标题被相关性过滤吃掉**：第一版 `relevantOnly` 只保留「当前段标题之后」的非条目行，
  结果 `# 用户画像 v231` 与 `> 生成于…` 一起被删，下游再也说不出这是哪一版画像。
- **相关性开关改不动**：`inject.relevantOnly` 落地时漏了 `SET_SPEC` 与 `settings` payload，
  面板改了也存不进去。

## 验证

- `node --check` 9 个文件全 0。
- `_selftest.mjs` 全部通过（新增 3 条相关性闸门断言）。
- `_audit.mjs` 33/33；`_audit2.mjs` **34/34**（新增 10 条：证件号/银行卡/密码拦截、`--force` 后仍打码、
  三类分区统计、item 带 `partition`、相关性开关可读写、加密导出与解密往返、错口令必须失败）。
- `_render.mjs` 全部通过（新增「只带入和本轮相关的条目」「导出时加密」两处文案断言）。
- `_e2e.mjs --cli-only` 26/26；`scripts/verify-install.mjs` 13/13。

## 真实环境

- `profile status` 的 `maxChars/topK` 已改为 0（旧配置里遗留的 1600/8 是被显式 `set` 掉的，
  迁移只改「默认值残留」）；`inject.relevantOnly=true`。
- 真实画像重建到 v232：16 条 → 分区 `user_profile 11 / user_preference 5 / user_social_network 0`。
- `profile validate` 对真实 17 条声明：不合格 0 条（说明新闸门不会把既有数据判死）。

## 仍未做（诚实清单）

- 本机静态加密（rest 时全库加密）：需要每次读写都解密，收益在于「硬盘被拿走」这一种场景，
  代价是每次 CLI 调用都要口令。当前把力气花在「不落原文 + 出门必加密」上。
- 相关性匹配是字符二元组，不含语义：同义改写（「界面」vs「UI」）匹配不上，会走「全带」兜底。
- 面板还没有分区维度的可视化（数据已在 payload 里）。
