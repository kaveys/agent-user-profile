# 安全与隐私

## 这个插件接触哪些数据

| 数据 | 落在哪 | 默认 |
| --- | --- | --- |
| 你确认过的画像条目 | `declarations.jsonl` | 明文，纯本地 |
| 模型提炼的候选 | `pending.jsonl` | 明文，纯本地 |
| 每轮的工具名/步数/成败 | `observations/YYYY-MM.jsonl` | 明文；默认**不**进画像 |
| 对话正文 | 只在内存里，轮末送当前模型提炼 | **不落盘** |
| 快照 | `snapshots/declarations-*.jsonl`（最多 20 份） | 明文，纯本地 |
| 溯源 | 条目里的 `provenance`（来源、时间、会话、原话前 80 字） | 明文，纯本地；由 `--excerpt` 决定要不要记 |
| WebDAV 备份包 | 你配置的远端路径 | 默认关闭；启用后整包上传 |

没有遥测、没有第三方服务。网络请求只有两处：宿主自己的模型调用，以及**你显式启用 WebDAV 后的备份上传**。

## 脱敏（v15）

- 写入前替换四类预设：手机号 `1[3-9]xxxxxxxxx`、邮箱、18 位证件号、常见密钥前缀（`sk-` / `ghp_` / `github_pat_` / `AKIA` / `xox?-`）。
- 替换成占位符（如 `⟨手机号⟩`），并在回执里说明命中几处；原文不落盘。
- 历史条目用 `profile redact` 先扫描后写回（`--apply`），写回前自动留快照。
- 姓名、住址、学号等不在预设里，需要自定义 `redaction.patterns`；`redaction.mode=unknown` 时不做任何替换（明确表示「规则还没定」，而不是假装安全）。

## WebDAV 备份的边界（v15）

- 密码只从环境变量（默认 `DSH_PROFILE_WEBDAV_PASSWORD`）或 `secrets.json` 读，**不写进 config.json**，也不进备份包。
- 备份包里的 `config.backup.webdav` 会把 `url` / `username` 清空、`passwordEnv` 复位后再上传。
- 上传失败一律报错退出，不静默降级；`--out` 本地导出不需要任何网络。
- 远端只写 `<remoteDir>/<host>-<时间戳>.json`，不删除远端其它文件（`keepLast` 只在本机保留快照，不清理服务器）。

## 报告安全问题

请不要开 public issue。用 GitHub 的 **Report a vulnerability**（Security 标签页）或直接邮件联系仓库维护者。

请包含：受影响版本、复现步骤、影响面（例如「画像条目里的 `<!--dsh-user-profile-->` 会让下一轮误判已注入」）、以及你希望我如何标注信用。

## 已知边界（不是漏洞，但值得知道）

- 画像正文来自用户与模型，属于**不可信输入**：渲染时会消毒 Markdown 结构标记，但它仍然是模型读到的文本。把画像当数据，而不是指令 —— 注入块里的规定来自插件代码，不来自条目。
- HTTP 面板路由用宿主的 `connection.requestRejection` 做网关校验；在 loopback 直连时宿主可能返回 `undefined`（视为放行），此时只依赖本机权限边界。
- `restore` 只接受 `snapshots/` 下的白名单文件名，`import` 只读你显式给出的路径。
