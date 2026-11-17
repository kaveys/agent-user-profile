# v5 变更：面板从「插件仪表盘」改成「用户自己的画像」

一句话：**界面上只留回答「我是谁、我的偏好怎么被使用」的信息；一切说明「插件怎么运转」的数据全部撤出。**

## 1. 删掉的（及理由）

| 位置 | 原来 | 现在 | 理由 |
| --- | --- | --- | --- |
| 页签 | 「数据」（9 条存储路径 + 导出/导入/重置） | 「备份与重置」（只留导出 / 导入 / 重置） | 路径是作者排障用的，用户不需要知道 `declarations.jsonl` 在哪 |
| 概览 KPI | 8 张（版本 / 条目 / 声明型 / 行为信号 / 证据·阈值 / 待审 / 单轮工具数 / 最后生成） | 4 张（画像条目 / 你确认过的 / 待你确认 / 上次更新） | 「行为信号 12 轮」「证据 19/3」是采集健康度，不是用户画像 |
| 概览卡片 | 「近 14 天活跃」柱、「常用工具构成」、「运行状态」六行 | 「各维度条目数」「优先级分布」「当前策略」五行人话 | 用户没调用过 `pwsh`，看到「pwsh 30%」只会困惑；策略应该说成人话 |
| 画像条目 | 由运行统计生成的「常用工具占比 / 单轮平均调用 / 活跃时段」 | 默认不产出（`build.includeObservedItems=false`） | **最刺眼的一条**：机器行为被混成用户特征 |
| 设置页 | 每字段下方灰字 `inject.maxChars`、`build.similarityThreshold` | 只留一句中文说明 | 面向用户的开关应读作一句话 |
| 画像 Markdown 头部 | 「证据：声明 X 条 / 行为 Y 轮；约 Z 次工具调用」 | 「依据：X 条已确认（其中 M 条由模型提炼）· N 轮对话」 | 同一事实，人话表达 |
| 注入块头部 | 「证据 N 条 · 完整画像用 profile show」 | 「生成于 … · 共 N 条 · 按权重降序」 | 注入块是给模型看的，应说画像本身 |

## 2. 设置项：17 → 12（全部改成结论式标签）

| 分组 | 字段 | 标签 |
| --- | --- | --- |
| 画像怎么被使用 | `enabled` | 每次任务前自动参考画像 |
| | `inject.mode` | 什么时候参考（每轮都带 / 只在被要求时带） |
| | `inject.maxChars` | 最多带多少字 |
| | `inject.topK` | 最多带多少条 |
| | `build.minEvidenceForPortrait` | 至少多少条才启用 |
| 说法冲突时 | `conflicts.strategy` | 同一件事有两种说法（以最新为准 / 两条都留等你判断） |
| | `build.dedupe` | 自动合并重复条目 |
| 自动整理 | `extract.enabled` | 聊完自动整理新偏好 |
| | `extract.everyTurns` | 每几轮整理一次 |
| | `extract.autoAcceptConfidence` | 多确定才自动收录 |
| 更新与隐私 | `build.autoBuild` | 画像随对话自动更新 |
| | `capture.turnText` | 允许读取对话正文来提炼 |

移出界面（仍可通过 CLI / `config.json` 调整）：`inject.distillHint`、`build.similarityThreshold`、`build.observedTtlDays`、`build.autoBuildMinIntervalMs`、`extract.maxFactsPerTurn`、`redaction.mode`。

## 3. 数据层

- `DEFAULT_CONFIG.build.includeObservedItems: false` —— `aggregateObserved()` 仍返回 `turns/steps/ok/fail`（用于「证据够不够」），但 `items` 恒为空，除非显式打开。
- `panel` payload：18 键 → 13 键，删 `paths / home / activity / toolMix / hours`；`live` 精简为 `{declarations, modelFacts, pending}`。
- `stats`：收敛到 `items / declared / modelFacts / core / pending / dimCounts / weightBuckets / conflictStats / history`，删 `avgSteps / toolCalls / turns / evidence / minEvidence`。
- 措辞：条目徽章 `声明 / 行为` → `已确认 / 我的观察`；条目表副行只留「更新于 …」，不再显示内部 id 与 key。
- 重建后真实画像：`items=9`、全部 `kind=declared`（三条工具统计条目随重建消失）。

## 4. 回归

```
node --check index.js client.js bin/profile.mjs     # 全 0
node tests/render.mjs                                    # 26 项全 PASS（含 payload 洁净度 3 条）
node tests/selftest.mjs                                  # 全 PASS（含 includeObservedItems 开关对照）
node scripts/verify-install.mjs                     # 12 项全 PASS
node scripts/register.mjs                           # 已同步 4 个文件到安装目录
```

新增断言：
- `payload 不再包含存储路径`
- `payload 不再包含活跃/工具统计`
- `payload 统计只剩面向用户的键`
- `默认不把工具统计写进画像` / `显式开启后仍能聚合出常用工具`

## 5. 生效方式

| 改动 | 生效条件 |
| --- | --- |
| `client.js` | 热重载，**刷新设置页**即可（Ctrl+F5） |
| `bin/profile.mjs` | 每次请求起新进程，立即生效 |
| `index.js` | **必须重启 dsh** |

## 6. 真机截图

docs/screenshots/：01-overview.png、02-items.png、07-backup.png（在设置页「用户画像」里实际点开截的）。
说明：截图抓于最后两处微调之前 —— 条目表的权重列现在显示 **高 / 中 / 低** 而不是 0.9 / 0.6 / 0.45；概览的「画像条目」卡片在有合并时会补一句「N 条判为同义已合并」。
其余四个页签（待审 / 冲突与历史 / 维度 / 设置）由 
ode tests/render.mjs 逐页签断言覆盖（26 项全 PASS）。

## 7. 仍未做

- 面板内不能改「单个条目的权重」（只能设核心 / 删除；权重由置信度与录入顺序推出）。
- 敏感信息脱敏规则仍为 `unknown`（待用户确认规则后再落正则）。
- 跨工作区作用域隔离已实现但在界面上不暴露（避免又一个内部概念上桌）。
