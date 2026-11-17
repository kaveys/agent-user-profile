# v15：把「数据绝对有效」做成闸门，并补齐 MCP / 脱敏 / 溯源 / WebDAV

> 触发需求（原话）：**「修的全都修，加MCP、脱敏、溯源，条数不设上限但要求数据绝对有效，加入WEBDAV上传功能」**

这一版做的是**质量与边界**，不是新功能堆叠：先修三处自相矛盾，再用「准入即校验」替代「靠截断控制体积」。

## 一、先修三处自相矛盾

| 症状 | 真因 | 修法 |
| --- | --- | --- |
| 画像里偶尔少条目，没人报错 | `readJsonl` 的 `catch` 直接 `continue`，坏行被静默吞掉（违背 CONTRIBUTING 的「不许静默丢数据」） | 坏行隔离到 `<file>.bad-<日期>`，好行原子写回，并 push 一条 `warnings`（面板顶部黄条 + `status` 的「注意」行都会显示） |
| 并发时 CPU 飙一格 | `withLock` 用 `while (Date.now() < until) {}` 空转等锁，最坏 200×50ms = 10 秒占满一个核 | 换成 `Atomics.wait` 真睡（`sleepSync(ms)`），锁语义不变 |
| 红线条目被裁，背景参考反而留下 | `renderInject` 给「红线 40% / 个性化 75%」两段百分比帽，且个性化段不设条数上限，与「红线 > 个性化 > 参考」相反 | 三段共用**一个绝对预算、先写先得**（红线 → 个性化 → 参考），百分比帽全部删除 |

## 二、「条数不设上限」怎么做到不失控

不是去掉限制，而是**把限制前移**：

- `inject.maxChars = 0`、`inject.topK = 0` 表示不设上限（`DEFAULT_CONFIG` 已改成 0）。
- 体积由 `renderInject` 的 `limit = 0` 处理：0 就不截断；设了正数才按优先级截断，并在末尾提示「另有 N 条被 topK 限制在外；设 0 可全部带入」。
- 质量由**有效性闸门**保证：`validateEntry(record, config)` 逐条检查

  | 检查 | 拒绝理由 |
  | --- | --- |
  | 长度 3..400 | 「内容太短 / 内容过长」 |
  | 结构破坏 | 正文里的 `#` 标题、`<!-- -->`、`【插件规定】` 会伪造注入结构 |
  | 换行 | 一条会变成多条 |
  | 维度存在 | 维度被删掉后的孤儿条目 |
  | confidence ∈ 0..1 | 越界权重 |
  | key 非空 | 缺 key 会被同维度条目顶掉 |
  | 命中「本次 / 这一轮 / 临时 / 这个文件」等词 | 「看起来是本次任务的细节」，换个任务就不成立 |

- 闸门有逃生阀：`--force` 强行写入（stderr 明确提示违反了哪几条）。**默认拒绝，而不是默认放行。**
- `scope=project` 的条目不套用「本次任务细节」这一条 —— project 条目的存在意义就是项目内有效，用全局门槛卡它等于把这一级废掉。

配套命令 `profile validate`：只体检不改数据；`--quarantine` 才把不合格条目移到 `invalid-<ts>.jsonl`（移之前先留快照）。

## 三、脱敏（写入前，不是写入后）

四个内置预设，`redaction.mode` 默认 `preset`：

| 预设 | 匹配 | 替换为 |
| --- | --- | --- |
| `phone` | `(?<!\d)1[3-9]\d{9}(?!\d)` | `⟨手机号⟩` |
| `email` | 常见邮箱形态 | `⟨邮箱⟩` |
| `idcard` | `(?<!\d)\d{17}[\dXx](?!\d)` | `⟨证件号⟩` |
| `secret` | `sk-…` / `ghp_…` / `github_pat_…` / `AKIA…` / `xox?-…` | `⟨密钥⟩` |

- `declare` 在**落盘前**替换，回执追加「（已脱敏 N 处敏感内容）」。
- 历史条目用 `profile redact` 扫描：默认只报「N 条含敏感内容，共 M 处」；`--apply` 才写回（写回前自动留快照，保留 `redactedFrom` 前 120 字）。
- 自定义规则仍然可用（`redaction.patterns`），且面板「设置 → 敏感信息处理」可选 preset / patterns / unknown 三态。

## 四、溯源（provenance）

每条声明型条目带：

```json
"provenance": { "kind": "user" | "model", "at": "…", "session": "…", "turn": 12, "excerpt": "用户原话前 80 字" }
```

- 默认 key 也从「维度名」改为 `${dim}.${factKey(fact)}`（djb2 指纹）：**同一句话更新那条，不同的话各自成条**。旧写法在同一大类里写第二条会顶掉第一条——这是「条目莫名消失」的另一个来源。
- 面板条目副行显示「更新于 … · 你亲口说的 / 模型提炼 … 」，鼠标悬停可看原话摘录；`panel` 的 `items[].provenance` 与 `pending[].provenance` 都可读。

## 五、MCP（让别的宿主也能用同一份画像）

`mcp/server.mjs` —— 零依赖、stdio、行分隔 JSON-RPC 2.0：

- **stdout 只走协议，日志全走 stderr**（客户端解析很脆，一行日志就能让它断连）。
- 握手：`initialize`（回显客户端 `protocolVersion`，缺省 `2024-11-05`）、`notifications/initialized`、`ping`。
- 十个工具：`profile_get`、`profile_status`、`profile_search`、`profile_declare`、`profile_forget`、`profile_set_weight`、`profile_review`、`profile_validate`、`profile_backup`、`profile_set`。
- 两个资源：`user-profile://portrait`（注入用的三段式文本，优先 `inject.md`）、`user-profile://declarations`。
- 每个工具都是「参数 → 调 CLI → 回文本」的薄封装，**不重复业务逻辑**，所以 MCP 版和 CLI 版不可能行为不一致。

接入示例（Claude Code / Cursor 的 MCP 配置）：

```json
{ "mcpServers": { "user-profile": { "command": "node", "args": ["C:/Users/<you>/.dsh/plugins/dsh-user-profile/mcp/server.mjs"] } } }
```

## 六、WebDAV 备份

`backup.webdav`：`url` / `username` / `passwordEnv`（默认 `DSH_PROFILE_WEBDAV_PASSWORD`）/ `remoteDir` / `autoUploadOnBuild` / `timeoutMs`。

- 密码**永不写进 config.json**：先读环境变量，再读 `secrets.json`。
- `profile backup` 上传；`--list` 列远端（PROPFIND）；`--pull <name>` 下载；`--dry-run` 只算体积；`--out <目录|文件>` 本地导出（不配 WebDAV 也能用，面板「导出到本地」走的就是它）。
- 上传内容是可回灌的整包：`kind` / `schemaVersion` / `exportedAt` / `host` / `config`（含 webdav 的账号与地址会被清空）/ `declarations` / `pending` / `profile`。
- 目录不存在自动 MKCOL（405 视为已存在）。网络失败一律 `die`，不假装成功。

## 七、面板新增

- 「备份与重置」新增 **体检 · 脱敏 · 云端备份**：`体检条目` / `扫描敏感信息` / `脱敏并写回` / `导出到本地` / `上传到 WebDAV` / `看远端备份`。
- 顶部新增**数据提示条**（黄）：坏行隔离、配置文件损坏后重建等，都显式说出来。
- 「设置」新增「云端备份（WebDAV）」组；`最多带多少字` / `最多带多少条` 的说明改为「0 表示不设上限」。
- `index.js` 的 `ACTIONS` 新增 `validate` / `redact` / `backup`（备份给了更长的超时：上传 60s、列目录 40s）。

## 八、验证

| 套件 | 结果 |
| --- | --- |
| `node --check`（9 个文件，含 `mcp/server.mjs`） | 全 0 |
| `tests/selftest.mjs` | 全通过 |
| `tests/audit-1.mjs` | 33 / 33（新增「0 = 不设上限」与「负数必须拒」两条） |
| `tests/audit-2.mjs` | 21 / 21 |
| `tests/render.mjs` | 全通过（新增备份页三组入口、条目副行断言） |
| `tests/e2e.mjs --cli-only` | 26 / 26（新增闸门、脱敏、溯源、备份包、未配 WebDAV 报错、**MCP 握手**六条） |
| `scripts/verify-install.mjs` | 13 / 13（新增「MCP server 随包安装」） |

MCP 单独冒烟：`initialize` → `tools/list`（10 个）→ `profile_status` / `profile_search` → `resources/read` → 未知方法返回 `-32601`，通知不回包。

## 九、生效方式

| 改了什么 | 怎么生效 |
| --- | --- |
| `bin/profile.mjs`（闸门、脱敏、备份、新命令） | 立即（每次请求现起子进程） |
| `client.js`（面板新增按钮/提示条） | 刷新设置页（HMR） |
| `index.js` 的 `ACTIONS`（`validate`/`redact`/`backup`） | **重启 dsh** |
| `mcp/server.mjs` | 由外部宿主按配置拉起，与 dsh 无关 |

## 十、仍未做

- 向量检索 / 语义相似度去重：目前去重只认字符二元组 Dice（阈值 0.45），语义同义还得 `profile merge` 人工判。
- 脱敏只覆盖四类预设，姓名、住址、学号等需要自定义 `redaction.patterns`。
- WebDAV 只做单文件 PUT，没有断点续传与多端冲突合并。
- MCP 只实现 tools/resources 两个能力，没做 `prompts` 与订阅（`resources/subscribe` 返回不支持）。
