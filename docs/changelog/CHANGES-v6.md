# v6 — 画像改成「大类」划分

## 一句话

原来六维（身份 / 偏好 / 工作方式 / 专业领域 / 约束 / 沟通）是按「怎么服务一个任务」切的；现在换成十个大类，按「这个人是谁」切——身份、学业与职业、能力与工具、习惯与节奏、兴趣与爱好、审美与口味、目标与计划、关系与协作、约束与红线、沟通与表达。

## 划分依据

三条原则，按优先级：

1. **一类只回答一个问题**。答不出「这一类回答的是哪一问」，就不该独立成类。
2. **稳定压过详尽**。会随项目变的东西一律进 `goals`，不许占用 `identity`——否则半年后画像里全是过期项目名。
3. **最容易混的两对用一句话切开**：
   - `work` 是「在哪做什么」，`skills` 是「会什么」；学校与专业进 `identity.school/major`，岗位进 `work.title`。
   - `taste` 是「喜欢什么样」（界面风格、内容口味），`communication` 是「要我怎么说」（长度、结构、语气、语言）。

## 十类

| id | 中文 | 收什么 | 常用细分 key |
| --- | --- | --- | --- |
| `identity` | 身份与背景 | 称呼、年龄、性别、所在地与时区、母语、学校与专业、家庭角色 | name / age / city / lang / school / major / role |
| `work` | 学业与职业 | 在读还是在职、行业与岗位、负责什么、所在团队与项目 | status / field / title / project |
| `skills` | 能力与工具 | 熟悉的技术栈、软件与语言、熟练程度、常用工具链 | stack / tool / lang / level |
| `habits` | 习惯与节奏 | 作息与专注时段、做事方式、整理与备份习惯、更新与交付节奏 | hours / style / ritual / cadence |
| `interests` | 兴趣与爱好 | 游戏、音乐、影视、阅读、运动、收藏、动手创作 | game / music / film / book / sport / craft |
| `taste` | 审美与口味 | 视觉风格、界面口味、内容偏好、品牌与产品喜好 | style / visual / content / brand |
| `goals` | 目标与计划 | 正在学什么、短期与长期目标、在推进的项目、时间点 | now / long / learning / deadline |
| `social` | 关系与协作 | 和谁一起做事、团队里的角色、沟通对象、分享与公开习惯 | team / peer / share |
| `constraints` | 约束与红线 | 禁忌与硬性要求、必须遵守的做法、不可触碰的话题或操作 | must / never / limit |
| `communication` | 沟通与表达 | 回答长度与结构、语气、用什么语言、要不要表格/代码/清单 | length / tone / format / lang |

两级结构：**大类 = `dim`，细分 = `key` 的前缀**（`skills.editor`、`habits.hours`、`interests.game`）。这样既有一眼看懂的十栏，又不用为「他用什么编辑器」单独开一栏。

为什么是十类而不是二十类：分类的价值在「落得进去、找得出来」。超过十几类以后，同一个事实总能塞进三四个格子，模型每次挑得不一样，画像就开始漂。宁可少而稳。

## 连带改动

- **配置 schemaVersion 3**：`dimensions` 换成新十类，`dimensionLabels` 保留用户自定义的。
- **老数据迁移**（`migrateDeclarationDimensions`）：`preferences` 是个筐——工具偏好、回答格式、界面审美全塞在里头。所以迁移不是简单改名，而是按内容重新归类（`classifyLegacy`：熟悉/掌握→`skills`；回答/格式/表格→`communication`；流程/节奏/备份/重做→`habits`；界面/风格/观感→`taste`…），每条记录留 `previousDim` 便于回溯，整份文件先备份成 `declarations.jsonl.bak-dimsv<n>-<ts>`。
- **行为统计归位**：`workflow.tools / workflow.intensity / workflow.rhythm` → `habits.*`（它们描述的是节奏，不是职业）。
- **提取器提示词**（`index.js` 的 `EXTRACT_SYSTEM`）：从硬编码六行改成由 `DIMENSION_GUIDE` 生成，并明确写进那两对易混分类的切法——分类漂移的根源在提示词，不在后处理。
- **面板「维度」页 → 「画像大类」**：每行显示大类名 + `id` 徽章 + 一句「收什么」+ 条目数，一眼能判断该往哪塞。
- **`profile dims list`** 也会打印每一类的说明，命令行里同样看得到分类标准。

## 验证

| 项 | 结果 |
| --- | --- |
| `node --check`（index.js / client.js / bin/profile.mjs / tests/selftest.mjs / tests/render.mjs） | 全 0 |
| `tests/selftest.mjs` | 全部通过（含 schemaVersion 3 迁移、备份文件、行为条目落 `habits`） |
| `tests/render.mjs` | 26 项全部通过 |
| `verify-install.mjs` | 12 项全部通过 |
| 真实数据迁移 | `config.json` v2 → v3；11 条声明全部落到新大类，`items=10 · rev=30` |
| 隔离副本迁移演练 | 备份生成 `config.json.bak-v2-*` + `declarations.jsonl.bak-dimsv2-*`，条目无丢失 |

迁移后实测落点：`constraints` 3 条、`taste` 4 条、`skills` 1 条、`habits` 1 条、`identity` 1 条。其中「用户熟悉 DSH 插件机制」原本被判进 `taste`（迁移发生时用的还是旧规则集），已用 `edit --dim skills` 归位——**自动归类只做粗排，落点仍需人眼过一遍**，这也是保留 `edit` 的原因。

## 生效方式

- CLI 与面板数据：立刻生效（每次请求现起子进程）。
- 面板界面文案（「画像大类」页）：`client.js` 走热重载，刷新设置页即可。
- `index.js` 的提取提示词：**需重启 dsh** 才会用新提示词提炼（旧进程里还是老的六维描述）。

## 未做

- 大类之间不做层级（比如把 `skills` 挂到 `work` 下）。真要做层级，得先有「同一事实只能出现在一个父类下」的约束，否则同一条会在两个地方各出现一次。
- 不提供「合并两个大类」。分类一旦开始合并，历史条目的 `dim` 就得跟着改，收益不抵风险。
