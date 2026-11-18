# 定位、命名与移植

> 这份文档回答三个问题：这个项目**卖的是什么**、仓库和包**叫什么**、怎么**装到别的宿主上**。

## 一、定位演进

| 阶段 | 说法 | 问题 / 为什么改 |
| --- | --- | --- |
| v1（开发期） | "DSH 插件：采集用户数据生成画像" | 听起来像又一个记忆库，和 mneme / dsh-memgas 撞车 |
| v2–v11 | "用户画像插件 + 设置页面板" | 更像成品，但仍是"DSH 的工具"，可达人群被宿主锁死 |
| **v12（当前）** | **Agent 的用户画像层，DSH 优先实现** | 核心与宿主解耦，CLI 单独可跑；DSH 只是第一个适配器 |

一句话定位：

> **它不负责记住发生了什么，只负责记住"你是谁、要我怎么做事"，然后每次动手前先看它。**

## 二、命名

| 位置 | 名字 | 说明 |
| --- | --- | --- |
| GitHub 仓库 | `agent-user-profile` | 两个搜索热词：`agent` + `user-profile`；排序上优先于 `dsh-*` |
| npm / 插件包名 | `dsh-user-profile` | **刻意不改**：这是 DSH 适配器的名字，宿主 loader 按裸包名解析，改名会打断已装实例 |
| CLI 可执行名 | `dsh-profile` | 短、好敲；未来做通用 MCP/CLI 版本时再加 `agent-profile` 别名 |
| 数据目录 | `~/.dsh/user-profile` | 与宿主解耦：可用 `DSH_USER_PROFILE_HOME` 指到任意位置，所以 CLI 不依赖 DSH 也能跑 |

改名要动的东西（现在**不要**动）：`~/.dsh/cordis.patch.yml` 的 `insert.name`、`<profile>/node_modules/dsh-user-profile` 链接、`dsh.client` 声明。三者一致才加载，缺一样就静默失效（见 README「三件必须齐备的东西」）。

## 三、搜索词矩阵

仓库 `description`、topics、README 首段应覆盖下面这些词，且**只在真能用上的地方出现**（堆词会被判定为垃圾仓库）：

- 角色：`agent`、`coding-agent`、`llm`、`assistant`
- 功能：`user-profile`、`user-modeling`、`personalization`、`preference`、`persona`
- 相邻但不同：`agent-memory`、`memory-layer`、`prompt-context`（用来说"我不是记忆库"，也顺带被搜到）
- 宿主：`deepseek-harness`、`dsh-plugin`（明确归属，接住生态内的搜索）

## 四、和同类项目的位置

| 项目 | 它解决什么 | 与本项目的差别 |
| --- | --- | --- |
| [mneme](https://github.com/slow-stack/mneme) | 通用记忆：SQLite + Markdown 镜像、矛盾冻结、可回放 | 它记"发生了什么"，本项目只记"你是谁"；它需要 MCP + daemon，本项目零依赖 |
| [dsh-memgas](https://github.com/quqxui/dsh-memgas) | 四通道检索（FTS5 / 向量 / 图 PPR）+ 后台进化 | 检索强，但没有"单轮喊停"，也没有画像条目的人工权重 |
| [dsh-memory-core](https://github.com/AstroLiao/dsh-memory-core) | 纯 Markdown 记忆 + `systemPrompt` 注入 | 覆盖式写入、无冲突概念；本项目有权重、冲突三态（merged / resolved / frozen）、快照回滚 |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Claude Code 全生命周期钩子 + AI 压缩观察 | 记录面很宽；本项目只保留能改变"下次做法"的结论 |
| [mem0](https://github.com/mem0ai/mem0) / [getprofile](https://github.com/getprofile/getprofile) | 通用记忆服务 / drop-in LLM proxy | 服务化、要部署；本项目是**文件 + 一个 CLI**，可以整目录拷走 |
| [dsh-user-portrait](https://github.com/qazsedcftg/dsh-user-portrait) | 九维度画像 + 证据账本（每条结论带置信度与来源会话）、我的备注优先、删除分两级 | 它的画像是「按需取用」：默认不注入，要开会话开关。本项目相反，默认每轮叠加。**已借鉴**：删除分两级的思路 → 本项目的「先放下」（`retire`），记录留在 `declarations.jsonl` 里可恢复 |
| [dsh-tool-user-memory](https://github.com/IAMLieutenant/dsh-tool-user-memory) | 置顶偏好、软失效、替换时显示新旧对照、回答下方即时撤销 | **已借鉴**：置顶成为独立注入段位（每轮必带、豁免相关性闸门），`edit` 输出逐项新旧对照。差别在形态：它是模型工具 + 交互按钮，本项目是面板 + CLI + MCP 三条路共用同一份存储 |

差异化的三句话（放 README 首屏就够）：

1. **单轮喊停**：一句"这次别用画像"，本轮不注入并在结果里声明，下一轮自动恢复——整个生态只有这里有。
2. **准入门槛**：三道检查（跨任务 / 会改变做法 / 说的是用户本人），项目细节永不入画像。
3. **可审计可回滚**：每条带权重与来源，删前自动快照，面板一键回到任意时点。

## 五、核心与适配器的分界

移植时只需要重写右列，左列原样复用。

| 核心（宿主无关） | DSH 适配器（宿主相关） |
| --- | --- |
| 画像 schema（十大类、key 命名、权重、来源、scope） | `session/event` 钩子采集（`turn/start`、`tool/call`、`user/message`…） |
| 准入门槛与提炼提示（`EXTRACT_SYSTEM`） | `ctx.llm.prepareCall` 调宿主模型做轮末提炼 |
| 三段式注入渲染（红线 / 个性化首选 / 背景参考） | `agent/pre-step` 插话位置与去重标记 |
| 冲突三态与去重（相似度合并） | 设置页 `settings.section` slot 与两条 HTTP 路由 |
| 快照 / 恢复 / 导入导出 / CLI 全部命令 | `cordis.patch.yml` 注册与 profile 级 node_modules 链接 |

## 六、移植路线（按投入排序）

1. **CLI-only（今天就能用）**：`node bin/profile.mjs build` 产出 `inject.md`，任何 agent 只要能读文件就能用；`DSH_USER_PROFILE_HOME` 指到项目内即可隔离。
2. **MCP server**：把 `declare / build / review / panel` 包成工具，任何支持 MCP 的宿主直接接入（Claude Desktop、Cursor、Codex…）。核心代码不用动，加一层 stdio 适配。
3. **原生适配器**：Claude Code 的 `UserPromptSubmit` / `Stop` 钩子、Cursor 的 rules 注入。每个适配器约 200–400 行，复用同一套核心。

## 七、要提升可发现性，还差三件事

| 动作 | 为什么值得做 | 成本 |
| --- | --- | --- |
| 首屏 20 秒 GIF：面板点 `＋` 改权重 + 一句"这次别用画像"后的声明 | 这两幕别人没有，GIF 比十段文字有效 | 半小时 |
| 英文 README（可与中文并存，`README.en.md`） | GitHub 的默认流量是英文搜索；`user-profile` + `agent` 的组合词在英文区才算有量 | 一小时 |
| `npx agent-user-profile demo` 一行出效果 | 大部分人不会为了试一个插件去装宿主 | 两小时 |

> 提醒：仓库元数据里的 `OWNER` 占位符要换成真实 GitHub 用户名（`package.json` 的 `repository` / `homepage` / `bugs`）。
