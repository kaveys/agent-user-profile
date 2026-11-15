# dsh-user-profile · 用户画像插件设计说明

> 版本 0.1.0 · 目标形态：DSH（DeepSeek Harness 桌面版）本地 cordis 插件
> 已落地位置：`%USERPROFILE%\.dsh\plugins\dsh-user-profile\`，数据目录 `%USERPROFILE%\.dsh\user-profile\`
> 本文档中所有未被用户确认的参数一律写作「（待补充：…）」，实现里对应字段保持默认值或保守关闭，不做推断。

---

## 一、插件概述

**一句话**：把「用户说过什么、怎么干活」沉淀成本机一份可读的画像文件；此后每次任务开始，插件自动把这份画像叠进上下文，除非用户当场喊停。

三段职责，边界清晰：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 插件（`index.js`） | 采集结构信号、每轮注入画像、识别喊停 | 不做语义总结、不判断"这条值不值得记" |
| 存储层（`bin/profile.mjs`） | 只追加落盘、确定性聚合、版本台账、归档 | 不调模型、不联网 |
| 模型（skill `user-profile`） | 把一轮任务总结成一条可复用事实，`declare` 写入 | 不直接改 `profile.json`，一律走 CLI |

**为什么采集和总结要分开**：采集如果放模型手里，会漏、会重复、会夹带正文；总结如果放代码里，只能做计数，写不出"他讨厌大段文件整读"这种结论。所以采集走钩子（确定性），总结走模型（语义），中间用 append-only 的 JSONL 隔开——可审计、可重放、可整体删除。

**为什么默认叠加走 pre-step 而不是写 AGENTS.md**：AGENTS.md 是静态文件，画像每轮都可能变；写进 AGENTS.md 等于把用户画像固化成"永不过期的指令"，用户以后想改就得改配置文件。走 `agent/pre-step` 才能做到「读最新版本 + 每轮注入一次 + 单轮撤销」。

---

## 二、功能模块说明

### M1 采集模块（`session/event` 钩子）

| 采什么 | 来源 | 落盘字段 | 开关 |
| --- | --- | --- | --- |
| 一轮用了哪些工具、各几次 | `tool/result` 事件的工具名 | `tools:[{tool,count}]` | `capture.toolNames` |
| 一步/一轮的成功与失败次数 | `tool/result` 的 `isError` | `ok` / `fail` / `steps` | `capture.turnSignals` |
| 轮次起止与耗时 | `turn/start`、`turn/end` | `at` / `durationMs` | `capture.turnSignals` |
| 对话正文 | —— | **默认不采集**（`capture.userText=false`） | 只能显式打开 |

采集面刻意做窄：**只采行为结构，不采内容**。原因是内容里最可能夹带隐私（口令、身份证、客户名单），而结构信号（用什么工具、多久一轮、几点干活）已经足以支撑"工作方式"这一维画像。

### M2 记录与存储模块（`bin/profile.mjs`）

- 两种写入通道：
  - `declare --dim D --fact "…"` —— 声明型事实，**唯一的语义入口**，进 `declarations.jsonl`；
  - `session/event` 自动追加 —— 行为信号，进 `observations/YYYY-MM.jsonl`（按月分片，便于按时间裁剪）。
- 写入即追加，不覆盖；覆盖语义只发生在 `build` 的聚合阶段（见 M3）。
- 每次 `build` 往 `changelog.jsonl` 记一行差异台账（版本号、证据数、冲突数），画像可回滚。
- `reset --yes` 把全部数据 `rename` 进 `archive/<时间戳>/`，不是 `rm`，误删可捞回。

### M3 画像生成与更新模块（`build`）

确定性聚合，四步：

1. **归并**：声明型按 `dim + key` 分组，`lastSeen` 最新的作为当前值；
2. **留痕**：被顶掉的旧值降级进该维度的 `history`，同时在 `conflicts` 写一条 `status:"resolved"` 记录（谁被谁覆盖、按什么规则）；
3. **降权**：行为信号只进 `workflow` 维，权重 `observedWeight`（默认 0.4），且超过 `observedTtlDays`（默认 90 天）的观察直接不参与聚合；
4. **定状态**：证据数 0 → `empty`；< `minEvidenceForPortrait`（默认 3）→ `insufficient`；否则 `ready`。

`revision` 单调 +1，`builtAt`/`stats` 一并写入，便于判断"这份画像是几时、基于多少证据得出的"。

**更新触发时机**（当前实现，可调）：
- 显式：模型在轮末或用户说"记一下"时调 `declare` + `build`；
- 隐式：采集每轮自动发生，`build` 由下一次显式调用合并（因此画像可能"落后几轮"，注入块里的 `生成于` 字段就是给模型判断陈旧度的）。
- （待补充：画像的更新触发时机与更新频率）——是否需要"每 N 轮自动 build"或"每日定时 build"，配置项已预留位置但未启用自动调度。

### M4 画像调用模块（`agent/pre-step` 钩子）

每轮第一个可用步骤执行一次判定，五种结局：

| 条件 | 行为 |
| --- | --- |
| `config.enabled === false` | 不注入（全局关闭） |
| 本轮用户消息命中 `suppressPatterns` | 注入一段**不含画像内容**的替代提示，要求模型在结果里声明「本次未结合用户画像」 |
| `inject.mode === 'on-request'` | 不注入（改为仅用户点名时才用） |
| 画像状态不是 `ready`（`empty`/`insufficient`） | 不注入，静默降级，不打扰 |
| 正常 | 注入 `<system-reminder>` 画像块：版本号、生成时间、正文（按 `inject.maxChars` 截断）、以及"冲突以本轮证据为准"的元规则 |

同一轮内用 `<!--dsh-user-profile-->` 指纹去重，避免多步重复注入把上下文吃满。

---

## 三、数据与画像结构定义

### 3.1 落盘布局

```
%USERPROFILE%\.dsh\user-profile\
├── config.json                  配置（开关、预算、阈值、抑制短语、维度表）
├── declarations.jsonl           声明型事实（append-only）
├── observations\YYYY-MM.jsonl   行为信号（append-only，按月）
├── profile.json                 构建产物（结构化，机器读）
├── profile.md                   构建产物（渲染态，注入的就是它）
├── changelog.jsonl              构建台账（版本、证据数、冲突数）
└── archive\<时间戳>\             reset 的归档
```

### 3.2 记录结构

```jsonc
// declarations.jsonl 一行
{ "id":"dcl_xxx", "at":"ISO", "dim":"preferences", "key":"tone",
  "fact":"回答要详细展开，给依据", "source":"user|model",
  "confidence":1.0, "session":"可选" }

// observations/YYYY-MM.jsonl 一行
{ "at":"ISO", "kind":"turn", "tools":[{"tool":"ops_bash","count":7}],
  "steps":9, "ok":8, "fail":1, "durationMs":123456 }
```

### 3.3 画像结构（`profile.json`）

```jsonc
{ "schemaVersion":1, "revision":7, "builtAt":"ISO",
  "status":"ready",                       // empty | insufficient | ready
  "privacy":{"mode":"unknown","rules":0}, // 见第五节隐私项
  "stats":{"declarations":5,"turns":12,"toolCalls":180,"evidence":17,"minEvidence":3},
  "dimensions":{
    "preferences":{"label":"偏好","items":[ Item, ... ],"history":[ Item, ... ]},
    ...
  },
  "conflicts":[ {"dim":"communication","key":"tone","status":"resolved",
                 "rule":"…","from":{"text":"…","at":"…"},"to":{"text":"…","at":"…"}} ]
}
```

`Item` 字段与关系：

| 字段 | 含义 | 与其他字段的关系 |
| --- | --- | --- |
| `id` | 稳定标识 | 与 `history[].supersededBy`、`conflicts` 互指，形成版本链 |
| `kind` | `declared` / `observed` | 决定可信度：declared 压 observed |
| `key` | 维度内分组键 | 同 `dim+key` 才可能冲突；不同 key 永不互相覆盖 |
| `text` | 一句话结论 | 注入时原样出现，所以要写成"可直接当前提用"的句子 |
| `weight` | 0–1 | declared 取 `confidence`；observed 取 `observedWeight` |
| `firstSeen` / `lastSeen` | 首次/最近出现 | 支撑"过期降权"与"冲突取新"两条规则 |
| `evidence` | 指向原始记录 id | 点得回去看原始依据，避免"画像里凭空多出一条" |
| `source` | `user` / `model` | 用户亲口 vs 模型推断，冲突时用户优先 |

**维度（v6 十大类，见 docs/CHANGES-v6.md）**：`identity` 身份与背景、`work` 学业与职业、`skills` 能力与工具、`habits` 习惯与节奏、`interests` 兴趣与爱好、`taste` 审美与口味、`goals` 目标与计划、`social` 关系与协作、`constraints` 约束与红线、`communication` 沟通与表达。大类下用 `维度.细分` 的 key 分层。

> （待补充：用户画像应包含的维度与粒度）。当前 6 维是通用骨架，写在 `config.json.dimensions` 里，改这个数组即可增删维度，无需改代码；**每维内部的粒度（例如 `preferences` 要不要细分到"工具偏好/审美偏好/交付格式偏好"）未确认，暂按"一条一条 fact"扁平存储，靠 `key` 自然分簇。**

---

## 四、画像调用与默认叠加规则

### 4.1 默认规则（原文可执行版）

> **执行任何任务前，先读取并叠加用户画像；只有当用户明确提醒不使用画像时，才跳过这一步。**

映射到实现：`inject.mode = "always"` + 每轮 `agent/pre-step` 注入一次 `profile.md`（版本、时间、正文、元规则）。

注入块的元规则（写在块内，随画像一起进上下文）：
1. 画像是**背景知识**，不是本轮指令；与本轮明确指令冲突 → 以本轮为准；
2. 与代码/文件/数据中的可见事实冲突 → 以本轮证据为准；
3. 发现条目明显过期或错误 → 用 `declare` 修正，不要默默沿用。

### 4.2 例外处理（用户喊停）

- 识别方式：本轮最后一条用户消息命中 `config.json.suppressPatterns`（默认含「不使用画像」「忽略画像」「不参考画像」「no profile」「--no-profile」等）。
- 行为：**不注入任何画像内容**，改为注入一段固定提示，要求模型在最终结果里明确写一句「本次未结合用户画像」。
- 粒度：**单轮生效**，下一轮自动恢复默认叠加（不记忆"用户上次喊停过"，避免一次偶然关闭变成永久关闭）。
- 归零方式：`set enabled false`（全局关）/ `set inject.mode on-request`（改为点名才用）。

### 4.3 边界条件

| 场景 | 规则 |
| --- | --- |
| **数据为空** | `status=empty`，不注入；`show` 明确告知"暂无数据"，`status` 显示 0 条。模型仍可正常干活，只是没有画像前提。 |
| **数据不足** | 证据 < `minEvidenceForPortrait`（默认 3）→ `status=insufficient`，同样不注入。**宁可不叠，也不拿 1 条样本当画像**，避免以偏概全。 |
| **冲突** | 同 `dim+key`：declared 压 observed；都是 declared 则 `lastSeen` 新者胜，旧值进 `history` 并写 `conflicts`（`resolved` + 规则说明）。**`unresolved`（同时间戳、来源不可分）时不选边**：注入块里只列双方并标"未决"，让模型按本轮证据判断。 |
| **过期** | 行为信号超 `observedTtlDays`（默认 90 天）不参与聚合；声明型不自动过期（用户的话不因时间而失效），但注入块带 `生成于`，模型可据陈旧度打折。 |
| **画像损坏** | `profile.json` 解析失败 → 视为不可注入，插件静默跳过（所有 IO 在 try/catch 内），绝不阻断任务。 |
| **敏感信息** | 采集面默认不含对话正文；脱敏钩子 `redaction.patterns` 已预留但**默认为空数组**，`privacy.mode` 记为 `unknown`。规则未确认前不做推断：既不假装已脱敏，也不擅自定义什么算敏感。 |
| **用户要求删除** | `reset --yes` 归档（不是删除）全部数据；`archive/` 留给用户自行决定是否彻底清除。 |

---

## 五、使用与维护说明

### 5.1 安装（本机已执行）

```bash
# 1) 插件本体
cp -r dsh-user-profile ~/.dsh/plugins/
# 2) 注册（等价于往 ~/.dsh/cordis.patch.yml 追加 insert 块，已备份 .bak-userprofile-*）
node dsh-user-profile/scripts/register.mjs
# 3) 链接（关键，Windows 上必须用 junction；MSYS 的 ln -s 会退化成目录复制）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-user-profile" "%USERPROFILE%\.dsh\plugins\dsh-user-profile"
# 4) 初始化数据目录
node ~/.dsh/plugins/dsh-user-profile/bin/profile.mjs init
# 5) 静态体检（12 项，不用重启）
node dsh-user-profile/scripts/verify-install.mjs
# 6) 重启 dsh 生效：双击 scripts/restart-dsh.cmd
```

**为什么需要第 3 步**：loader 加载插件用的是 `import("dsh-user-profile")` 这个裸包名，解析基准是
`~/.dsh/profiles/<profile>/`，不是 `~/.dsh/plugins/`。本机所有第三方插件（`dsh-creative-studio`、
`dsh-todo-sync`、`dsh-mcp-deferred`）都是靠 profile 的 `node_modules` 里放链接挂上去的。
少了这一步，`cordis.patch.yml` 里的 insert 行会让 loader 报 `ERR_MODULE_NOT_FOUND`，
表现就是「插件装了但什么都没发生」——`~/.dsh/user-profile/observations/` 一直是空的。

**为什么用 junction 不用 `ln -s`**：本机 MSYS 的 `ln -s` 在无符号链接权限时退化为**目录复制**，
复制出来的是死副本（改插件不生效、`realpathSync` 不指向安装目录）。`mklink /J` 建的是 reparse point，
`lstatSync().isSymbolicLink()` 为 true、`realpathSync` 指向安装目录。`mklink` 的路径参数不要用引号包整串。

### 5.2 日常用法

```bash
CLI="node $HOME/.dsh/plugins/dsh-user-profile/bin/profile.mjs"
$CLI status                                  # 有没有画像、开了没、几条证据
$CLI declare --dim preferences --fact "…"    # 记一条
$CLI build                                   # 重算画像（注入读的就是这一步的产物）
$CLI show                                    # 看注入的原文
$CLI set enabled false                       # 关默认叠加
$CLI reset --yes                             # 归档清空
```

模型侧：skill `user-profile` 把上面命令固化成"什么时候写、写什么、别写什么"的纪律，用户不需要记命令。

### 5.3 维护

| 事项 | 做法 |
| --- | --- |
| 调预算 | `set inject.maxChars 2400`（注入正文上限，默认 1600 字符） |
| 调阈值 | `set build.minEvidenceForPortrait 5`、`set build.observedTtlDays 30` |
| 加抑制短语 | 直接编辑 `config.json.suppressPatterns`（数组） |
| 加维度 | 改 `config.json.dimensions` + `bin/profile.mjs` 的 `DIMENSION_LABELS` |
| 审计 | `changelog.jsonl` 看每版差异，`declarations.jsonl` 看每条事实的出处 |
| 回滚配置 | `~/.dsh/cordis.patch.yml.bak-userprofile-*` |
| 卸载 | 删 `~/.dsh/plugins/dsh-user-profile`，并移除 `cordis.patch.yml` 里的 `user-profile` insert 块；数据目录可单独保留 |

### 5.4 自测与体检

```bash
cd dsh-user-profile && node _selftest.mjs    # 40 条：空/不足/就绪/冲突newest+freeze/两段式注入/喊停/去重/作用域/待审/落盘/关闭/归档/面板401·405·权重降序
node scripts/verify-install.mjs              # 12 项安装体检：patch 行、裸包名解析、bundle 形状、主题变量、ESM 导出
```

`verify-install.mjs` 是「重启前能做的全部验证」：它把 dsh 真实的加载条件逐条复现
（`dsh.bundle.patch` 文件存在、`dsh.client.platform === "web"`、`exports["./client"]` 是字符串、
client bundle 是 `__ModuleLoader__.load` 形状、没 require 宿主客户端包、着色只用 `--dsw-alias-*`、
`index.js` 能被 ESM `import` 且导出 `name`/`apply`）。任何一项 FAIL 都意味着重启后设置页不会出现。

---

## 五点五、v2 增补（对照 GitHub 同类项目后的六条改进）

对照 `AstroLiao/dsh-memory-core`、`quqxui/dsh-memgas`、`slow-stack/mneme`、`thedotmack/claude-mem`、`memodb-io/memobase`、`getprofile/getprofile` 等实现后，按性价比落地了四条，并补上设置页：

| # | 改进 | 落点 | 为什么不照抄生态 |
| --- | --- | --- | --- |
| 1 | **两段式注入** | `bin/profile.mjs` 的 `renderInject()` 预算出 `inject.md`：核心段（`constraints`/`identity` 或 `--core`）最多占 70%，其余按权重取 `inject.topK` 条填充 | 生态普遍是检索 top-k；本插件是全量注入，`maxChars` 硬截断会砍掉尾部——而红线类事实最怕被砍 |
| 2 | **作用域** | `scope: global/project/session` + `--scope-id`；`build` 只并 `global` 与同 id 的 `project` | 记忆类插件多为单库单用户；本机多项目并行时"本项目用 pnpm"不该污染别的项目 |
| 3 | **冲突第三态** | `conflicts.strategy = newest \| freeze`；`freeze` 两条并留标「未决」，`review` 裁决 | `lastSeen` 新者胜是我们原来的默认（比 dsh-memory-core 的静默覆盖谨慎），但 `mneme` 的"先冻结再问人"更不越权，故做成可选 |
| 4 | **待审候选** | `declare --pending` 入 `pending.jsonl`，不进画像；`review --accept/--reject` 才落库 | 对应 `dsh-memgas` 的 `confirmWrites`：模型自己学的东西不该直接改画像 |
| 5 | **设置页面板** | `client.js` → `settings.section`（id `user-profile`, order 55）；数据走宿主 `GET /user-profile/panel.json` | 生态里 `mneme`/`dsh-memory-core` 有设置面板，用户能看见画像才敢信它 |
| 6 | 检索式召回 | 未做 | 全量两段式 + topK 在个人画像规模（几十~几百条）已够；上检索要向量库，违背零依赖前提 |

### 设置页面板的数据链路

```
设置页打开
  └─ client.js · ProfileSection（手写 CJS-loader bundle，require("react") 用宿主实例）
       └─ fetch GET /user-profile/panel.json
            └─ index.js · panelHandler（GET/HEAD；其它方法 405）
                 └─ execFileSync(node bin/profile.mjs panel) → 扁平 JSON（2s 缓存）
                      └─ flatten(profile, config)  ← 与 renderInject 共用同一个排序
```

要点：
- **同一套排序**：`flatten()` 产出的 `rank/weight/core/frozen/scope` 就是注入块的排序依据，面板不会显示一份"看起来对"的画像。
- **不写 CSS 字面颜色**：全部用 `--dsw-alias-*` 主题变量（`label-primary`/`border-l2`/`brand-primary`/`state-warn-primary`…），亮暗主题由宿主切换。
- **构建**：手写 bundle 符合 `window.__ModuleLoader__.load({id, factory})` 契约，无需 tsdown/vite；`package.json` 的 `dsh.client.platform="web"` + `exports["./client"]` 是 client-modules 扫描的唯一入口，改完必须重启 dsh。
- **失败隔离**：`panelBody()` 全包 try/catch，CLI 挂了返回 `{ok:false,error}`，页面显示错误条而不是白屏；`ctx.inject(['webServer'])` 外层也有 try/catch，无 Web 宿主时面板接口缺席、注入逻辑不受影响。

### 五点六、v2.1 排障结论：注入链路的三处断点

复验方式不是「读代码猜」，而是三条独立证据链：真机点开设置页截图（页签存在、页面正常渲染）、
`GET /user-profile/panel.json` 直接取 200 + JSON、会话日志 `session.v4.jsonl.zstd` 用 `zlib.zstdDecompressSync` 解压后统计事件类型与字段。

| 断点 | 证据 | 修复位置 |
| --- | --- | --- |
| 画像永不生成 | `~/.dsh/user-profile` 无 `profile.json`；`status` 报「未生成」；面板表头 v0 · 共 0 条 | `index.js` `turn/end` → `autoBuild()`（60s 节流、在飞去重、成功清面板缓存） |
| 工具名记成 unknown | 观察记录 `常用工具：unknown 100%`；日志里 `tool/result.data` 无 `name`，`tool/call.data` 有 `{turn,step,callId,name,arguments}` | `toolNameOf()` 按 `data.*` 取值；`tool/call` 计数、`tool/result` 记成败 |
| 空态命令不可执行 | 面板提示 `dsh-profile build`，而包内 bin 未进 PATH | `panel` 增 `cli:{node,script}`，面板拼绝对路径命令 |

另外两处「沉默的错误」一并修掉：`config.json` 停在 `schemaVersion: 1`（`loadConfig()` 自动迁移 + 备份）；面板证据行
在画像缺失时读实时 `live` 统计，不再谎报「行为 0 轮」。

设计含义：**采集/聚合/注入三段里，任何一段只被代码"认为"正确，就可能在真实事件契约变化时静默失效**。
所以 v2.1 之后每个断点都留了可观测点 —— `panel` 的 `live` 段、`status` 的注入字符数、`log('injected', mdSource, …)`，
下次契约再变时不必再靠截图猜。

### 五点七、v2.2 智能提取：把「对话」变成「画像事实」

v2.1 修完之后画像能生成了，但生成出来的只有行为信号（「单轮平均 37.3 次工具调用」「活跃时段 17:00」）——
这不是画像，是使用统计。身份、偏好、红线完全依赖人手动 `declare`，等于把最需要智能的一步留给用户。
v2.2 把这一步接上模型。

**为什么放在轮末、而不是边聊边抽**：一轮之内模型自己正在做事，中途插入一次抽取调用会抢上下文窗口、
也会让「用户这句话是偏好还是任务指令」缺少后文判断。轮末攒够一轮（用户说的 + 助手答的）再抽，
判断有上下文，且一轮最多一次，成本可控（`extract.everyTurns` 可再稀释）。

| 环节 | 实现 | 取舍理由 |
| --- | --- | --- |
| 取材 | `user/message` + `assistant/message`，只取 `type==='text'` 块 | 思考过程与工具参数不是「用户是谁」的证据；把它们喂进去只会诱导模型编造 |
| 缓冲 | `WeakMap` 内存缓冲，单轮 40 条 / 每条 4000 字，`turn/start` 清空 | 会话对象做键 → 会话销毁即释放；正文**永不落盘**，落盘只有结论 |
| 调用 | `ctx.llm.prepareCall(config, signal)` → `stream({...config, messages, system, purpose:'user-profile-extract'})` | 复用宿主自己的模型适配器与凭据，插件不需要 API key、不需要新增依赖 |
| 路由 | 优先 `request/header` 的 `data.header.config.{provider,model}`；拿不到则读 assistant 消息的 `source:{kind:'model',provider,model}` | `request/header` 是 log-only 事件未必进钩子，双来源才能保证零配置可用 |
| 输出契约 | 只准输出 `{"facts":[{dim,key,fact,confidence}]}`，6 维白名单，`fact` 主语是「用户」≤40 字，`key` 稳定小写英文 | 强制结构化才能机械写入；`key` 是冲突检测的抓手（同 key 才谈得上"新值覆盖旧值"） |
| 清洗 | `parseFacts()`：剥 ```json 围栏 → 取首 `{` 至末 `}` → `JSON.parse` → 兼容数组/`{facts:[]}` → 过滤长度与维度 → confidence 夹到 0..1 | 模型输出永远可能带解释文字或围栏，解析必须比"信它守规矩"更结实 |
| 分流 | `confidence ≥ extract.autoAcceptConfidence`（0.7）直接 `declare`；低于阈值加 `--pending` | 明说的偏好（0.9）不该排队；一次表现（0.45）不该擅自写进长期画像 |
| 降级 | 模型不可用 / 超时 45s / JSON 不合法 / 路由缺失 → 静默 `log` 后放弃本轮 | 画像提取是增强项，失败不能影响主任务，也不能污染画像 |

隐私边界写死在实现里：**模型看到正文，磁盘只留结论**。`capture.turnText=false` 则连提取都不做，
退回「只有行为信号 + 手动 declare」的 v2.1 行为。模型写入的条目 `source: "model"`，可 `forget --id` 单条删、
`reset --yes` 整体归档。

可观测点：`status` / `panel` 都显示「声明 N 条（其中模型提炼 M 条）」，`_selftest.mjs` 第 14、15 组覆盖
提取全链路（含无 `request/header` 时路由取自消息 source 的退化路径）。

### 五点八、边界：任务清单不归本插件管（v3 修正）

v2.3 曾把「任务清单更新不及时」的提醒逻辑塞进本插件（`todoGuard` + `<!--dsh-todo-guard-->` 注入）。
那是越界：**任务清单是会话纪律，用户画像是关于"这个人是谁"的背景知识，两者没有因果关系，也不该共用一个生命周期。**

v3 起彻底切分：

| 关注点 | 归属 | 触发点 | 数据 |
| --- | --- | --- | --- |
| 任务清单更新 | `dsh-todo-sync`（独立插件） | `tool/call` 计数 + pre-step 提醒 | session 的 `todos` 投影 |
| 用户画像 | 本插件 | `turn/end` 采集 + 智能提取 + pre-step 注入 | `~/.dsh/user-profile/` 下的 JSONL/Markdown |

本插件已删除：`DEFAULT_CONFIG.todoGuard`、`readConfig` 里的合并行、`todoState`/`guardBlock`/`GUARD_MARKER`/`isGuardMessage`、
`case 'todo/write'`、pre-step 里的守护段与旧消息过滤、`panel` 对 `todoGuard` 的上报。
`_selftest.mjs` 第 16 组改为**守边界**：连续 6 次工具调用不得产生任何清单提醒；`todo/write` 的内容不得进入画像注入。

> 教训：两个能力挤在同一注入通道里，看起来只是"顺手加一段"，实际上会让任一方的策略变更都牵连另一方，
> 也会让用户困惑"到底是谁在提醒我"。互不相关的关注点必须落在不同的插件、不同的数据、不同的钩子里。

---

## 五点七、v4 增补：设置页从只读表变成控制台

用户要求「更加自定义，要有一个大型的、好用的插件的样子」。v4 把设置页重写成七页签应用，并补齐写通道。

| 页签 | 关键能力 |
| --- | --- |
| 概览 | 8 张 KPI + 过期警示条 + 维度分布 + 权重分布 + 近 14 天活跃柱 + 工具构成 + 运行状态 |
| 条目 | 搜索 / 维度过滤 / 三种排序 / 多选批量 / 行内编辑 / 二次确认删除 |
| 待审 | 逐条或整批接受、丢弃 |
| 冲突与历史 | 冲突双方并排 + 判定文案；历史留档标明「被覆盖」还是「判为同义合并」 |
| 维度 | 计数 + 新增 / 删除自定义维度 |
| 设置 | 4 组 17 个字段，只提交改动项，保存即重建 |
| 数据 | 9 条路径 + 导出 / 重建 / 批量导入 / 重置 |

**数据链路**（两条路由都过 `connection.requestRejection` 鉴权闸门）：

```
client.js --GET  /user-profile/panel.json--> index.js --> execFile profile.mjs panel
                                                                  └--> 18 键 payload（含 settings / live / drift / activity / toolMix / history）
client.js --POST /user-profile/action-----> index.js --> ACTIONS[action] --> execFile profile.mjs <子命令>
                                                                  └--> 写盘成功后 panelCache 失效
```

**四条设计约束**：只 `require('react')` 不引宿主客户端包、不写 JSX 不引入构建链；着色只用 `--dsw-alias-*`；
页面与注入块共用同一套 `flatten()` 排序（表格第一行即注入第一行）；写失败把 CLI 原文贴回页面而不是显示「操作失败」。

**为什么新增 `merge`**：自动去重只认字面相似度（Dice ≥ `build.similarityThreshold`，默认 0.45）。
措辞差得多的同义句不会被自动合并，而提高阈值又会误伤 —— 所以把判断权交回人：`merge --keep A --drop B`，
B 进 A 的 `mergedFrom`，changelog 记 `kind:'merge'`。

**为什么新增 `_render.mjs`**：面板改版最大的风险是「点了页签白屏」。该脚本自带极简 hooks 运行时，
把真实 `ProfileSection` 渲染成树并逐个页签点击断言文案，不依赖宿主与浏览器。三个坑：
每个组件要有独立 hook store；setter 必须绑定自己那份 store；`createElement` 必须把子节点塞进 `props.children`。

**生效矩阵**：`client.js` → 热重载（刷新设置页）；`bin/profile.mjs` → 每次起新进程，立即生效；
`index.js`（路由与动作表）→ **必须重启 dsh**，未重启时新动作返回 `400 未知动作`。

---

## 五点九、v5 修正：面板只讲用户，不讲制作过程

**用户判据**：「用户画像的设置界面为面向用户的，制作过程中产生的数据没必要存在」。

复盘时我把面板上的东西逐条过了一遍，问的是同一个问题：**这条信息回答的是「我是谁」，还是「这个插件怎么运转」？**

| 被删掉的 | 它回答的问题 | 为什么不属于用户界面 |
| --- | --- | --- |
| 「数据」页签的 9 条存储路径 | 数据存在哪个文件 | 作者排障用的；用户可以一辈子不打开那个目录 |
| 「行为信号 / 证据·阈值 / 单轮工具数」KPI | 采集链路健康度 | 是插件的自检指标，不是用户的画像 |
| 「近 14 天活跃」柱、「常用工具构成」 | Agent 干了多少活 | 用户没调用过 `pwsh`，看到「pwsh 30%」只会困惑 |
| 画像条目里的「常用工具占比 / 单轮平均调用 / 活跃时段」 | Agent 的运行统计 | **最刺眼的一条**：它们混在「用户的偏好」里，把机器行为说成用户特征 |
| 设置页每个字段下的 `inject.maxChars` 小字 | 配置键名 | 面向用户的开关应该读作一句话，不是读作一个 JSON 路径 |
| `profile.md` / `inject.md` 头部「证据 N 条 · 约 N 次工具调用」 | 聚合口径 | 换成「依据：N 条已确认 · M 轮对话」，同一事实，人话表达 |

**结构性修法（不是只改文案）**：
1. `build.includeObservedItems` 默认 `false` —— `aggregateObserved()` 仍算 `turns/steps/ok/fail`（「证据够不够」要用），但**不再产出条目**。工具占比从「画像内容」降级为「内部观测」，想看得显式打开（自测里专门有这条对照用例）。
2. `panel` 的 payload 从 18 键收敛到 13 键，删 `paths / home / activity / toolMix / hours`；`stats` 收敛到 `items / declared / modelFacts / core / pending / dimCounts / weightBuckets / conflictStats / history`。
3. 「数据」页签换成「备份与重置」：导出 / 导入 / 重置保留，只掉路径表（页签总数仍是 7）。
4. 设置项 17 → 12，标签全部改成结论式中文（「每次任务前自动参考画像」「说法冲突时：以最新一次为准」），不再出现 `newest` / `similarityThreshold` / `observedTtlDays` 这类内部词。
5. 权重不直接示人：条目表保留进度条（排序依据），概览里折成 **高 / 中 / 低** 三档。

**教训**：判据不是「这个数字有用吗」，而是「**用户会不会因为这个数字误解自己**」。工具占比恰好是后者 —— 它把 Agent 的行为伪装成用户的特征，比缺失更坏。

---

## 五点十、v9 增补：把「删错了」变成可回退，把状态做成看得见

### 5.10.1 恢复点：删除先留证据

数据层只有一个新增不变量：**任何删除动作之前，先把当前声明集整份快照**。

```
snapshots/declarations-forget-<ts>.jsonl    ← 删除前
snapshots/declarations-restore-<ts>.jsonl   ← 恢复前（恢复也可能恢复错）
```

- 最多保留 20 份，`listSnapshots(limit)` 取用；
- `profile restore --name <文件>`：再留一份 → 覆盖写回 → changelog 记 `kind:'restore'` → rebuild；
- 快照名是**唯一**的用户输入，所以 Host 侧 action 用 `/^declarations-[\w.-]+\.jsonl$/` 白名单挡路径穿越，再交给 CLI。

为什么不做「自动垃圾回收 + 版本树」：这不是数据库，20 份快照足够覆盖「手抖删了」的场景，多做的复杂度会压过收益。

### 5.10.2 UI 优化：状态可见性

没有样式表（手写 bundle + 内联 style），所以「好不好看」实际是「**状态能不能被看见**」：

| 机制 | 实现 |
| --- | --- |
| 悬停/按下 | `Btn` 内部 useState 自己算 `background`（`transition: background 120ms ease`） |
| 状态胶囊 | 圆点颜色映射 `ready/insufficient/empty/missing`，文字用人话（已就绪 / 证据还少 / 还是空的 / 未生成） |
| 页签计数 | 数字从文案里剥出来，做成独立 `tabCount` 胶囊；页签条 `position: sticky` 吸顶 |
| 提示条 | 左侧 2px 语义色边 + `×` + 8 秒自动清除（success/error 由文案前缀判定） |
| 加载/出错 | 骨架屏 / 错误卡片 + 重试，而不是一行灰字 |
| 危险区 | `dangerZone` 淡警示底，与普通表单区分 |

### 5.10.3 一次值得记的 bug

`snapshots.map(...)` 里括号错位，`snap` 落到了 `map` 外面：

```js
h('span', {...}, snap.name)   // ← 这里 snap 已不在作用域
```

`node --check` 不报（语法合法），运行到「备份与重置」页才 `ReferenceError`。**只有把真实组件渲染出来才能抓到** —— 这正是 `_render.mjs` 存在的理由：它不模拟浏览器，而是用最小 hooks 运行时把组件跑一遍再断言文案。

---

## 五点十二、v12：录入门槛收紧到「可能对全局有用」

v11 之前的准入标准是「跨会话可复用」，它会放过「这个仓库用 pnpm」这类项目局部信息，进了全局画像就会在无关任务里被当成用户特征注入。

新的唯一判据：**知道它，会不会让我下次做出来的东西更像他要的。**

三道检查（写在 `EXTRACT_SYSTEM` 里）：跨任务成立 / 能改变下次做法 / 说的是用户本人而不是本次任务。
落点两级：`scope: global` 进全局画像，`scope: project` 只在同工作区生效；提示里要求「拿不准就写 project」。
代码侧再加一道便宜兜底：`SESSION_SCOPED = /(本次|这一轮|这轮|当前任务|这个插件|这个文件|临时|待会)/`，命中即降级。

教训：画像的价值不在「记得多」，而在「记得准」——一条项目细节混进全局画像，比少记十条更坏。

## 五点十一、v10 增补：在真实列宽里做视觉

设置页内容列宽是宿给定的，约 630px —— 所有「两列并排」的构图到这里必然折行。v10 的三条硬约束：

1. **不为好看而增加列**。概览的两列改成竖排，条目表用固定列宽（84 / auto / 72 / 138），设置页字段一律单列。宁可长，不要挤。
2. **零值不做陈列**。一个没有条目的大类不出现在「画像分布」里；没有改动时不摆「保存」工具行；恢复点默认只露 5 份。空状态要么解释，要么整块消失，不留一排 `0 条`。
3. **危险动作必须有第二下**。批量删除改为「确认删除 N 条」两段式，并在删完后指路恢复点 —— 画像被清空三次，都是同一次点击造成的，不是误操作可以解释的。

另外记一条主题经验：`--dsw-alias-brand-primary` 在暗色下接近白色，用它做**实心按钮底**会让白字消失。主按钮一律「描边 + 品牌色文字」，不要靠填充表达强调。

---

## 六、待补充项清单

以下为**用户明确保留、尚未给定**的决策点。实现里每一项都停在"可配置但未启用推断"的状态，不替用户拍板。

1. **（待补充：插件的运行环境或平台规范、插件形态与命名）**
   现按本机实际规范落地：DSH cordis 插件（`package.json` + `index.js` + `cordis.patch.yml`），命名 `dsh-user-profile`，数据目录 `~/.dsh/user-profile`。若目标平台不是 DSH（例如换 IDE、换 agent 框架），M1/M4 的钩子需要重写，M2/M3 可原样复用。
2. **（待补充：可记录的用户数据来源与范围，以及不可记录的数据类型）**
   当前默认：只记录行为结构（工具名、步数、成败、耗时）+ 用户亲自确认的事实；**不记录对话正文、不记录文件内容、不记录凭据**。明确"不可记录"的清单需要用户给定。
3. **（待补充：用户数据的存储位置与存储格式）**
   当前默认：本地 `~/.dsh/user-profile`，JSONL + JSON + Markdown，不加密、不上传。是否需要加密、是否需要跨机同步、是否改到某个指定目录，待定。
4. **（待补充：用户画像应包含的维度与粒度）**
   v6 起为十大类，每类下用 `key`（如 `skills.editor`）分层；大类增删改走 `profile dims add/remove`，落盘在 `config.json.dimensions` + `dimensionLabels`。为何是十类、老六维如何迁移，见 `docs/CHANGES-v6.md`。
5. **（待补充：画像的更新触发时机与更新频率）**
   当前：采集每轮自动，`build` 由模型/用户显式触发（可能落后若干轮）。是否需要"每 N 轮自动 build""每日定时 build""轮末强制 build"，待定；定时能力可接 DSH automation，但未启用。
6. **（待补充：数据授权、隐私与敏感信息的处理方式）**
   当前：`privacy.mode = "unknown"`，`redaction.patterns = []`，即**不做任何脱敏替换**，只靠"不采正文"把面收窄。授权方式（一次性同意 / 每次同意 / 沉默即同意）、敏感类型清单、保留期限、删除权行使方式，全部待定；`redaction` 钩子已预留 `{name, pattern, flags, replace}` 结构，规则一到即可填入。

---

## 附：四模块调用时序

```
用户消息 ──► agent/pre-step ──┬─ 命中 suppressPatterns ──► 注入"本次未结合画像"提示 ──► 模型执行
                             └─ 否则读 profile.md ───────► 注入画像块 ───────────────► 模型执行
                                                                                          │
                                     session/event(tool/result, turn/end) ◄────────────────┘
                                                     │
                                        observations/YYYY-MM.jsonl（append-only）
                                                     │
模型在轮末总结 ──► declare --fact ──► declarations.jsonl ──► build ──► profile.json + profile.md
                                                                    （下一轮注入读新版）
```
