# agent-user-profile

**Agent 的用户画像层** —— 把散落在对话里的偏好、习惯、能力、红线沉淀成一份持久画像，此后每次任务默认叠加，用户喊停则跳过。

> 当前实现是 DeepSeek Harness（DSH）插件；核心（画像结构 / 准入门槛 / 三段式注入 / 快照回滚）与宿主解耦，CLI 单独可跑。

[![tests](docs/badges/tests.svg)](#自测与体检) [![license](docs/badges/license.svg)](LICENSE) [![node](docs/badges/node.svg)](package.json)

**[面向普通用户的介绍片（72 秒 · 中文配音）](docs/video/agent-user-profile.mp4)** · [字幕](docs/video/agent-user-profile.srt) · [旁白全文](docs/video/agent-user-profile-narration.txt) · [English README](README.en.md)

## 这是什么

一个**画像层**，不是记忆库，也不是聊天记录归档。它只回答一个问题：*知道这件事，会不会让我下次做出来的东西更像这个人要的？*

- 画像分十大类：身份与背景、学业与职业、能力与工具、习惯与节奏、兴趣与爱好、审美与口味、目标与计划、关系与协作、约束与红线、沟通与表达。
- 每条带权重（0–1）与来源（用户明说 / 模型提炼 / 行为观察），可手改、可删除、可整批回滚。
- 每次任务开始前按「红线 → 个性化首选 → 背景参考」三段注入；用户说「这次别用画像」就整条跳过，并在结果里声明本次未结合。

## 这不是什么

- **不是**跨会话记忆检索（那是 [mneme](https://github.com/slow-stack/mneme)、[dsh-memgas](https://github.com/quqxui/dsh-memgas) 做的事）。
- **不是**把聊天记录喂给模型再摘要（那会把项目细节、报错原文也变成"用户特征"）。
- **不会**记录文件名、路径、端口、版本号、一次性要求 —— 这类信息一律判为项目局部，不进全局画像。

## 三个别人没有的点

| 能力 | 说明 |
| --- | --- |
| **单轮喊停** | 说一句「这次别用画像」→ 本轮不注入，并在结果里声明；下一轮自动恢复，不需要改配置、不需要重启 |
| **快照回滚** | 每次删除/恢复前自动留档（最多 20 份），面板上一键回到任意时点；批量删除有二次确认 |
| **规定与数据分离** | 「优先级 / 不反问 / 喊停例外」等使用规则写在插件内部规定层，不进画像条目，改画像改不掉它 |

## 界面

设置页里就是全部操作面：概览看画像结构与分布，条目页改权重/编辑/删除，待审页裁决模型提炼的候选，冲突与历史看谁压过谁，备份与重置能一键回到任意时点。

![概览](docs/screenshots/01-overview.png)

![条目与权重](docs/screenshots/02-items.png)

## 快速开始（不装 DSH 也能试）

```bash
# 1) 只有 Node，没有宿主：直接跑 CLI，数据落在 ~/.dsh/user-profile（可用 DSH_USER_PROFILE_HOME 改）
node bin/profile.mjs init
node bin/profile.mjs declare --dim taste --fact "用户偏爱克制的深色界面" --confidence 0.9 --core
node bin/profile.mjs build --all-scopes && node bin/profile.mjs show      # 看渲染出来的画像
node bin/profile.mjs panel | head -40                                     # 面板数据（设置页读的就是它）

# 2) 装进 DSH：多出钩子注入、设置页「用户画像」、轮末自动提炼
```

## 结构

```
dsh-user-profile/
├── index.js             插件本体：采集钩子（session/event）+ 注入钩子（agent/pre-step）+ 面板数据路由
├── client.js            浏览器侧：设置页「用户画像」页签（手写 CJS-loader bundle，无需构建）
├── bin/profile.mjs      存储层 CLI（v2）
├── cordis.patch.yml     注册补丁片段
├── scripts/register.mjs 幂等注册进 ~/.dsh/cordis.patch.yml（自动备份）
├── _selftest.mjs        注入/采集/提炼 单元级用例
├── _e2e.mjs             33+ 项真实 CLI 与 HTTP 动作自检
├── _render.mjs          面板渲染烟测（不启动浏览器）
├── DESIGN.md            设计文档
├── docs/POSITIONING.md  定位、命名与移植到其它宿主
├── docs/CHANGES-*.md    每版变更记录
├── LICENSE              MIT
└── README.md
```

## 安装

```bash
cp -r dsh-user-profile "$HOME/.dsh/plugins/"
node dsh-user-profile/scripts/register.mjs   # 写 cordis.patch.yml + 给每个 profile 建 node_modules 链接
node "$HOME/.dsh/plugins/dsh-user-profile/bin/profile.mjs" init
node dsh-user-profile/scripts/verify-install.mjs   # 静态体检：12 项，不用重启
# 双击 scripts/restart-dsh.cmd 重启 dsh 后生效
```

**三件必须齐备的东西**（缺一样插件就是静默不加载）：

| 件 | 位置 | 作用 |
| --- | --- | --- |
| `insert` 行 | `~/.dsh/cordis.patch.yml` | 告诉 loader 要加载这个包 |
| 裸包名可解析 | `<profile>/node_modules/dsh-user-profile`（junction / 符号链接） | loader 用 `import("dsh-user-profile")` 解析，不是按路径读 |
| `dsh.client` + `exports["./client"]` | `package.json` | 浏览器端 bundle 的入口声明 |

本机 `ln -s` 在 MSYS 下会退化成**目录复制**（复制后就是死副本），所以 Windows 上必须建 junction：

```bat
cmd /c mklink /J "<home>\.dsh\profiles\desktop\node_modules\dsh-user-profile" "<home>\.dsh\plugins\dsh-user-profile"
```

`mklink` 的路径参数不要用引号包整串，否则报「文件名、目录名或卷标语法不正确」。

`package.json` 里 `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings"] }`、
`exports["./client"] = "./client.js"`，`files` 里带上 `client.js` —— 这三处缺一个，设置页就不会出现本插件。

## 宿主兼容（v19）

插件按**能力探测**运行，不按版本号：宿主少一个服务，就关掉对应功能，其余照常。

```bash
node bin/profile.mjs doctor   # 这一版宿主到底给了什么、哪一项现在不可用
```

| 宿主缺什么 | 结果 |
| --- | --- |
| `agent/pre-step` | 不自动叠加画像（其它照常） |
| `session/event` | 不采集对话与工具调用，只能 CLI / MCP 维护 |
| `webServer` / `connection` | 设置页读不到数据 / 面板没有 cookie 校验（都写进 `.host.json`） |
| `llm` | 不自动提炼条目，行为信号与手工条目照常 |
| 客户端 `slots` | 设置页少一个页签，客户端 `apply` 静默返回不抛 |

事件名也做了别名收敛（`tool_call` / `tool-call` / `tool/call` 视为同一件事），老宿主的事件名不会被当成脏数据丢掉。
完整矩阵、探测方式与不可兼容项见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 用法

```bash
CLI="node $HOME/.dsh/plugins/dsh-user-profile/bin/profile.mjs"

$CLI declare --dim preferences --fact "回答默认中文，交付要能直接运行"
$CLI declare --dim constraints --key no-emoji --fact "不要用 emoji" --core   # 核心：必进注入块
$CLI declare --dim workflow  --key pkg --fact "本项目用 pnpm" --scope project  # 只在同项目生效
$CLI declare --dim preferences --fact "喜欢深色主题" --pending                 # 只进候选，等确认
$CLI review                                  # 看候选；--accept all / --reject <id|all>
$CLI edit --id dcl_xxx --fact "新的说法"      # 改内容/维度/key/置信度/核心（--dim --key --confidence --core）
$CLI merge --keep dcl_a --drop dcl_b         # 语义相同但字面不像的两条，手动并成一条
$CLI forget --key preferences.single_responsibility   # 按 key 删；也支持 --dim / --all / --pending
$CLI import --file facts.json                # 批量导入；数组或 {"items":[…]}；--pending 只进候选
$CLI dims list                               # 十大类表（身份/学业与职业/能力与工具/习惯/兴趣/审美/目标/关系/约束/沟通）；add tooling 工具链 / remove tooling
$CLI observe --tools "ops_bash,ops_grep" --steps 2   # 钩子不可用时手动补一条
$CLI build                                   # 生成 profile.json / profile.md / inject.md
$CLI show                                    # 画像全文；--inject 看注入块；--json 看结构
$CLI panel                                   # 设置页用的扁平 JSON（条目按权重降序）
$CLI status                                  # 数据量 / 版本 / topK / 待审数 / 注入字符数
$CLI forget --id dcl_xxx                      # 删掉某条声明
$CLI validate                                # 体检：哪些条目「不合格」（只报告，不改数据）；--quarantine 才隔离
$CLI redact                                  # 扫描敏感信息；--apply 才写回（写回前留快照）
$CLI backup --out ~/backup                   # 本地导出整包；backup --list / --pull / --dry-run
$CLI set enabled false                       # 关掉默认叠加
$CLI reset --yes                             # 归档清空
```

## 查两件事：这次会带入什么、画像健康吗（v20）

```bash
node bin/profile.mjs explain "界面美化 风格"   # 这条话会带入哪些条目，哪些被相关性挡掉
node bin/profile.mjs explain "…" --json        # { carried, dropped, threshold }
node bin/profile.mjs health                    # 五项打分 + 短板建议
node bin/profile.mjs health --json
```

`explain` 用的就是注入那一套二元组相关度（`inject.relevanceFloor` 默认 0.12）：核心条目与红线维度永远带入，其余按「这句话被这条条目覆盖了多少」决定，挡掉不等于删除。`health` 五项各 20 分：新鲜度 / 覆盖度 / 精度 / 一致性 / 重点明确，实测 96 分那次扣分来自一条被取代的旧值。

## 条目凭什么算「有效」（v15）

条数不设上限（`inject.maxChars=0`、`inject.topK=0` 默认就是不限），体积靠**准入闸门**控制，而不是靠事后截断：

| 闸门 | 拒绝的情况 |
| --- | --- |
| 形状 | 短于 3 字 / 长于 400 字 / 含换行 / 含 `#` 标题、`<!-- -->`、`【插件规定】` 等能伪造注入结构的字符 |
| 归属 | 维度已被删掉、`key` 为空、置信度不在 0..1 |
| 时效 | 读起来是「本次 / 这一轮 / 临时 / 这个文件」这类一次性细节（`--scope project` 的条目不套用这条，因为它本来就只在项目内有效） |
| 逃生阀 | `--force` 可强行写入，但会在 stderr 说清违反了哪几条 |

`profile validate` 可以随时体检；`--quarantine` 会把不合格条目移到 `invalid-<时间戳>.jsonl`（移之前自动留快照）。

## 六步记忆流水线（v17）

画像不是「记下所有事」，而是一条有闸门的流水线。每一步都可以单独关掉：

| 步骤 | 做什么 | 默认 |
| --- | --- | --- |
| ① 触发判定 | 只有用户在讲自己（「我习惯…」「以后都…」）才提炼；翻译、做题、查报错这类纯干活的一轮直接跳过 | `extract.skipEphemeralTurns: true` |
| ② 抽取与归一 | 产出结构化键值 `{dim, key, fact, confidence, scope}`，正文不落盘；同义条目自动合并，被合并的进历史 | `build.dedupe: true` |
| ③ 冲突与分区 | 同一件事两种说法按 newest/freeze 处理；十条大类归到 `user_profile` / `user_preference` / `user_social_network` 三个分区 | `conflicts.strategy: newest` |
| ④ 加密 | 备份包上传默认加密（AES-256-GCM），`backup --out --encrypt` 也可加密导出，`profile unseal` 解回 JSON | 上传默认开 |
| ⑤ 相关性调用 | 注入前只保留和本轮相关的条目，红线永远带入；遮挡条数写在块尾，不自动扩散 | `inject.relevantOnly: true` |
| ⑥ 增删改 | 只有用户指令才删除；删除前自动留快照，面板「恢复点」可整批还原 | 始终生效 |

两条硬边界写在代码里、不由画像条目决定：

- **高风险隐私不记**：证件号、银行卡号、密码、精确住址直接拒绝（`--force` 才越过），因为「记着他有身份证号」没有画像价值。
- **不记原文**：磁盘上只有结构化条目，对话正文只在内存里拼成一次请求。

## 脱敏与溯源（v15）

- **写入前**脱敏：手机号 / 邮箱 / 证件号 / 密钥四类预设，命中即换成 `⟨手机号⟩` 这类占位符，回执写「已脱敏 N 处」。
- 历史条目用 `profile redact` 先扫描（只报告），确认后 `--apply` 写回。
- 每条带 `provenance`：来源（用户 / 模型）、时间、会话、轮次、原话前 80 字。面板条目副行会显示「你亲口说的 / 模型提炼」，悬停看原话。

## 默认不设上限，但也不失控

`build` 预渲染 `inject.md`，三段顺序写死：**红线与硬要求 → 个性化首选 → 背景参考**，共用一个绝对预算、先写先得。
没有分段百分比帽（旧版给红线 40%、个性化 75%，结果是红线先被裁）。设 `inject.maxChars` 为正数才按优先级截断，并在末尾说明「另有 N 条被 topK 限制在外；设 0 可全部带入」。

## MCP：让别的宿主也用同一份画像（v15）

```json
{ "mcpServers": { "user-profile": {
  "command": "node",
  "args": ["<安装目录>/dsh-user-profile/mcp/server.mjs"]
} } }
```

十个工具：`profile_get` / `profile_status` / `profile_search` / `profile_declare` / `profile_forget` / `profile_set_weight` / `profile_review` / `profile_validate` / `profile_backup` / `profile_set`；两个资源：`user-profile://portrait`、`user-profile://declarations`。
stdio + 行分隔 JSON-RPC 2.0，**stdout 只走协议、日志全走 stderr**。每个工具都是「参数 → 调 CLI → 回文本」的薄封装，所以不存在 MCP 版与 CLI 版行为不一致。

## WebDAV 备份（v15）

在设置页「云端备份」或 `config.json` 里配 `backup.webdav.{url,username,remoteDir}`；密码放环境变量 `DSH_PROFILE_WEBDAV_PASSWORD`（也可写 `secrets.json`），**不写进配置文件**。
`profile backup` 上传 / `--list` 列远端 / `--pull <名字>` 下载 / `--dry-run` 只算体积 / `--out <目录>` 本地导出。备份包含条目、待审、设置快照（其中的账号与地址会被清空），可直接导回。

## 默认叠加与例外

| 情况 | 行为 |
| --- | --- |
| 普通任务 | 每轮第一步注入画像（`inject.mode=always`） |
| 用户说「不使用画像」等 | 不注入画像，改为要求模型声明「本次未结合用户画像」 |
| 画像 `empty` / `insufficient` | 静默跳过，不打扰 |
| `inject.mode=on-request` | 只在用户主动要求时注入 |
| `set enabled false` | 全局关闭 |

抑制短语在 `~/.dsh/user-profile/config.json` 的 `suppressPatterns`，可自行增删。

### 注入是三段式、单一预算（v15）

见上文「默认不设上限，但也不失控」：红线 → 个性化首选 → 背景参考，共用一个绝对预算、先写先得；`maxChars=0` / `topK=0` 表示不截断。旧版（v2）的分段百分比帽已删除，因为它会让红线先被裁。

### 冲突与待审（v2）

- `conflicts.strategy=newest`（默认）：同 key 新值胜出，旧值进 `history`。
- `conflicts.strategy=freeze`：两条并留、标「未决」，注入时不选边，等 `review` 裁决。
- 模型学到的偏好先进 `pending.jsonl` 候选，`review --accept` 后才进画像。

## 设置页：用户画像（七个页签，只讲用户自己的事）

设置 → **用户画像**（order 55）。这一版按「面向用户的界面」重做：面板只说**用户是谁、偏好什么、画像怎么用**，不再陈列开发期/运行期数据（存储路径、工具占比、活跃时段、证据阈值、配置键名一律不出现在界面上）。

| 页签 | 能做什么 |
| --- | --- |
| **概览** | 4 张卡片（画像条目 / 你确认过的 / 待你确认 / 上次更新）；画像里有新条目没并进来时，顶部一行提示 + 「立即更新」按钮；各维度条目数、优先级分布（高 / 中 / 低）、当前策略（每次任务前 / 画像更新 / 新偏好 / 重复条目 / 隐私 五行人话） |
| **条目** | 搜索、维度过滤、排序（优先级 / 时间 / 维度）、多选批量「设为核心 / 删除」、行内编辑（维度 / 内容 / 核心）、逐行删除（二次确认 4 秒自动取消）；每行只标「已确认 / 我的观察 / 核心 / 未决·冻结」与「更新于 …」 |
| **待审** | 模型提炼出的低置信候选，逐条「接受 / 丢弃」，或一键全接受 / 全丢弃 |
| **冲突与历史** | 冲突双方并排（A/B）+ 判定文案（`判为同义，已合并` / `新值覆盖旧值` / `已冻结，不选边`）；下方历史留档标明「判为同义被合并」还是「被新值覆盖」 |
| **维度** | 每维条目数与删除（不删条目，只是不再出现在分栏里）、新增自定义维度（id + 中文名） |
| **设置** | 4 组共 12 个字段，全部用结论式中文标签（画像怎么被使用 / 说法冲突时 / 自动整理 / 更新与隐私），改完点「保存并重建」，只有改动过的项才提交 |
| **备份与重置** | **恢复点**（每次删除前自动留快照，逐份「恢复」两点确认）、导出备份（可指定目录）、批量导入（贴 JSON 或 JSONL）、重置全部数据（二次点击、5 秒内有效、先归档到 `archive/<时间戳>`） |

读写通道：`GET /user-profile/panel.json`（`profile panel` 输出，2 秒缓存）+ `POST /user-profile/action`（`declare / forget / edit / merge / review / set / settings / importText / export / restore / reset / dims / build`）。
两条路由都先过宿主的 `connection.requestRejection` 鉴权闸门；**页面与注入块共用同一套排序**，所以表格第一行就是注入时排第一的那条。
浏览器侧只 `require('react')`、只用 `--dsw-alias-*` 主题变量着色，亮/暗主题随宿主切换。

### v21：`set` 能改的键，面板一定看得到（双向核对）；v20 新增两块

- 概览：**画像健康度**卡（总分 + 五项条形 + 首条建议，低于六成转黄）。
- 备份与重置：**宿主能力**区（六项可用/缺失 + 最近 6 行诊断），没有记录时提示「重启一次 dsh 后会自动写入」。

### v9 界面与恢复点

- **状态可见**：顶部状态胶囊（已就绪 / 证据还少 / 还是空的 / 未生成）+ 版本行 + 「刷新」「立即更新」；页签数字改成独立小胶囊且吸顶；提示条带语义色边、可手动关闭、8 秒自动消失；加载态是骨架屏，出错是卡片 + 重试；危险操作收进红色区块。
- **恢复点**：每次删除前自动快照到 `snapshots/`（最多 20 份）。面板「备份与重置」可逐份恢复（两点确认，会先给当前状态也留一份）；命令行 `profile snapshots` 看全部、`profile restore --name <文件>` 恢复。
- 生效方式：改 `client.js` → 刷新设置页；改 `bin/profile.mjs` → 立即生效；**新增 action（如 `restore`）→ 需重启 dsh**（`scripts/restart-dsh.cmd`）。

### v10 视觉层（2026-11-15 晚）

在设置页真实列宽（约 630px）下重排，解决「元素同权重、看不出层次」：

- **一套最小体系**：间距 8/10/14/16/18，字号 11/11.5/12.5/13/17/24，圆角 卡片 12 · 按钮 8 · 胶囊 999，数字统一 `tabular-nums`。
- **概览**：头部拆两行（标题+胶囊+按钮 / 版本小字）；KPI 数值 24px、异常才用语义色；「画像分布」只列有条目的大类并按条数降序，一个大类都没有时整块不渲染（不再摆 10 行 `0 条`）；优先级分布与当前策略由两列改竖排，策略用 `88px 1fr` 网格、标签不折行。
- **条目**：列宽固定（维度 84 / 权重 72 / 操作 138），维度名与操作按钮都不再折行。
- **设置**：无改动时不摆工具行；有改动才出现品牌描边的粘性条「N 项待保存 · 保存并重建 / 放弃修改」。
- **备份与重置**：恢复点默认只显示最近 5 份，其余收进「展开全部 N 份」。
- **顺带补的护栏**：批量删除原来是「一点即批量 forget」（画像被清空三次都是这条路），现在第一下变成「确认删除 N 条」并显示条数，5 秒内再点才执行，事后提示可去恢复点整批还原。
- 详见 `docs/CHANGES-v10.md`，真机截图在 `docs/screenshots/`。

## 智能提取（v2.2）

画像不再只靠人手动 `declare`：每轮对话结束后，插件把这轮的**用户原文 + 助手回复**喂给宿主自己的模型，让它压成结构化事实写进画像。

| 环节 | 做法 |
| --- | --- |
| 取材 | `session/event` 的 `user/message` / `assistant/message`，只取 `type==='text'` 块（思考过程、工具参数不入料） |
| 缓存 | 只在内存（`WeakMap`，单轮上限 40 条 / 每条 4000 字），`turn/start` 清空 —— **正文永不落盘** |
| 模型 | `ctx.llm.prepareCall(...)` → `stream({...config, messages, system, purpose:'user-profile-extract'})`，模型/供应商沿用本轮会话自己的路由（读 `request/header`，取不到则读 assistant 消息的 `source`），零额外配置 |
| 输出契约 | 只输出 JSON：`{"facts":[{dim,key,fact,confidence,scope}]}`，限定 10 个大类，`fact` 主语是「用户」且 ≤40 字，`key` 是稳定小写英文（同 key 才能覆盖旧值） |
| 准入门槛（v12） | 三道检查全过才写：① 换一个毫不相关的任务还成立吗 ② 知道它会不会改变下次的做法 ③ 说的是用户本人而不是这次的任务/文件/报错。项目局部的一律 `scope:"project"`，默认丢弃 |
| 置信分流 | `confidence ≥ extract.autoAcceptConfidence`（默认 0.7）→ 直接入画像；低于阈值 → 进 `pending.jsonl` 等 `review` |
| 失败处理 | 模型不可用 / 超时（默认 45s）/ JSON 不合法 → 静默降级，本轮不上画像，行为信号照常记录 |

```bash
# 关掉智能提取（只保留行为信号）
$CLI set extract.enabled false
# 每 3 轮才提炼一次，并把自动入画像门槛提到 0.85
$CLI set extract.everyTurns 3 && $CLI set extract.autoAcceptConfidence 0.85
# 连正文都不读（最保守）
$CLI set capture.turnText false
```

隐私边界：**模型看到正文，落盘的只有结论**。`declarations.jsonl` 里模型写的条目都带 `source: "model"`，可以 `forget --id` 单条删除，也可以 `reset --yes` 整体归档。

## 与任务清单无关（边界声明）

本插件**不读、不写、不提醒**任务清单。清单的更新节奏由独立插件 `dsh-todo-sync` 负责，两者没有任何代码或数据交叉：

- 画像插件不监听 `todo/write` 事件，`config.json` 里也没有 `todoGuard` 一类字段；
- 画像注入的内容只来自 `declarations.jsonl` / `pending.jsonl` / `observations/`，与 `todos` 投影无关；
- 自测里有两条专门守着这条边界：「连续 6 次工具调用不产生任何清单提醒」「`todo/write` 的内容不会被塞进画像注入」。

```bash
# 想调节清单提醒，去改 dsh-todo-sync，不要找本插件
# <home>\.dsh\plugins\dsh-todo-sync\index.js  →  Config: { threshold, maxNudgesPerTurn, includeItem }
```

## 数据

全部在 `~/.dsh/user-profile`：`config.json`、`declarations.jsonl`、`pending.jsonl`、`observations/YYYY-MM.jsonl`、`profile.json`、`profile.md`、`inject.md`、`changelog.jsonl`、`archive/`。
落盘内容只有两类：**画像条目**（人写或模型提炼的结论，`declarations.jsonl`）与**运行观测**（轮数/工具名/成败/时段，`observations/`）。后者默认**不进画像**（`build.includeObservedItems=false`）—— 那是 Agent 的运行痕迹，不是「用户是谁」。
对话正文默认只在内存里过一遍（`capture.turnText: true` 只在提取时读，`false` 则连提取都不做）；脱敏钩子 `redaction.patterns` 默认为空 —— 隐私规则属（待补充）项，规则确定后填入即可。

## 自测与体检

```bash
node _selftest.mjs            # 注入 / 采集 / 提炼 的单元级用例（隔离 temp HOME）
node _e2e.mjs                 # 42 项真实 CLI 与 HTTP 动作自检（会打运行中的 dsh；--cli-only 跳过 HTTP）
node _audit.mjs               # 33 项对抗式边界检查（脏输入 / 冲突操作 / 锁 / 作用域）
node _audit2.mjs              # 34 项往返与极限（导出→重置→导入 / 坏行 / 坏配置 / 快照上限 / 并发）
node _audit3.mjs              # 51 项逻辑一致性（预算与排序 / 闸门顺序 / MCP 协议 / 面板自洽）
node _audit4.mjs              # 22 项兼容层自身（能力文件 / doctor / 别名事件 / 降级不崩 / 旧配置迁移）
node _audit5.mjs              # 31 项「两处说法不一致」（settings↔set / 计数自洽 / health 语义 / explain 语义）
node _compat.mjs              # 11 项残缺宿主（只有 ctx.on / 缺 pre-step / 无 ctx.on / 无 next / 旧事件名）
node _render.mjs             # 面板渲染烟测：7 个页签逐个点 + payload 洁净度
node scripts/verify-install.mjs   # 13 项安装体检（不重启、不起 dsh）
```

`_selftest.mjs` 覆盖：空数据降级、证据不足不注入、两段式注入（核心段 + topK）、同轮不重复注入、
喊停不注入但仍提示、作用域隔离、冲突 newest / freeze 两策略、待审候选进/不进画像、panel 权重降序与 rank、面板路由 401/405、
工具名取自 `tool/call`、config 自动迁移、轮末自动重建、轮末模型提取（高置信入画像 / 低置信进待审 / 非法维度丢弃 / 无 request/header 时路由取自消息 source）、
并发写不丢记录、陈旧锁自愈、同义去重、drift 一致性自检。

`_audit.mjs` 专挑「看起来能用、边界会出血」的地方：删仍有条目的自定义大类、删内置大类、非法/越界/未知的配置写入、edit 到不存在的维度、merge 自己到自己、空事实、越界权重、未 init 的目录、重复 id 导入、restore 路径穿越、空库 build、`--all-scopes` 是否泄漏别的项目、陈旧锁自愈与新鲜锁不硬闯。

`_audit3.mjs` 打的是「逻辑错」而不是「会不会崩」：预算收紧时是不是先裁了红线（规定里最优先的那段）、`topK` 会不会连个性化段一起裁、`本次带入 N 条` 有没有把被裁的算进去、隐私闸门与脱敏的先后顺序、同一句话重复声明是不是变成两条、`--accept all` 在空队列上会不会报错、MCP 的未知工具/未知方法/非法 JSON 是不是明确报错、面板的分区总数与权重排序是否自洽。

`_render.mjs` 自带一个极简 hooks 运行时（`useState/useCallback/useEffect/createElement`），把**真实的 `ProfileSection`** 渲染成树，
不需要浏览器也不依赖宿主 —— 面板改版后先跑它，能挡住「页签点了白屏」「字段读错路径」这类只有肉眼才发现的问题。

## v2.1 修复记录（2026-11-15）

用户报「画像插件好像有点问题」，真机复验后定位到三处真实缺陷（设置页页签与渲染本身是正常的）：

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 画像永远是「未生成」，注入恒为空，面板永远空表 | `build` 只能手动跑 CLI，插件从不触发 | `turn/end` 后 `autoBuild()`：`execFile` 调 `profile build --all-scopes`，60 秒节流 + 在飞去重 + 成功即失效面板缓存；`build.autoBuild=false` 可关 |
| 2 | 画像里出现「常用工具：unknown 100%」 | 事件真实形状是 `{type,seq,time,data}`：工具名只在 `tool/call` 的 `data.name`，`tool/result` 只有 `data.message.isError`；旧代码只读 `event.tool` | `toolNameOf()` 改读 `data.name/tool/toolName/message.name`，兜底扫 `message.content` 里的 `tool-call` 块；`tool/call` 计数、`tool/result` 只记成败；聚合时跳过历史 `unknown` 占位 |
| 3 | 空态让用户跑 `dsh-profile build`，实际 command not found | 包内 bin 未链接进 PATH | `panel` 输出 `cli: {node, script}` 绝对路径，面板拼成可直接复制的 `"node" "…\bin\profile.mjs" build` |

顺带修掉：`config.json` 停在 `schemaVersion: 1` 导致新字段只吃代码默认值 —— 现在 `loadConfig()` 自动迁移
（显式重置 `schemaVersion`，先备份成 `config.json.bak-v1-<时间戳>`）；面板证据行在画像缺失时改为读实时统计
（`live`），不再谎报「行为 0 轮」。

已知限制：面板路由的鉴权交给宿主 `connection.requestRejection`；本机 loopback 请求该钩子返回 undefined（放行），
因此**不额外要求会话 cookie**。仅绑定本机端口的单用户场景下可接受，若要收紧需在宿主侧加 token 校验。
