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
- 历史条目用 `node bin/profile.mjs redact` 先扫描后写回（`--apply`），写回前自动留快照。
- 姓名、住址、学号等不在预设里，需要自定义 `redaction.patterns`；`redaction.mode=unknown` 时不做任何替换（明确表示「规则还没定」，而不是假装安全）。

## 加密（v17）

- **会离开本机的只有备份包**，所以加密只做在这一层：WebDAV 上传默认加密，`backup --out --encrypt` 可加密导出。
- 算法 AES-256-GCM，密钥用 scrypt 从口令派生（16 字节随机盐、12 字节 IV，每次导出都不同）。
- 口令来源优先级：`--passphrase` → `DSH_PROFILE_PASSPHRASE` → `secrets.json` 的 `profilePassphrase`；口令长度不足 6 位直接拒绝。
- 加密包是 `{"kind":"dsh-user-profile-backup-sealed", ...}`，`node bin/profile.mjs unseal --file <包>` 还原成可 `import` 的 JSON；口令错时 GCM 校验失败并报「口令不对，或文件被改动过」，不会产出半截数据。
- **本机磁盘没有全库加密**：数据在 `~/.dsh/user-profile/`，靠操作系统账户隔离。理由写在 `docs/changelog/CHANGES-v17.md`——全库加密要求每次 CLI 调用都带口令，收益只覆盖「硬盘被拿走」这一种场景。

## 高风险隐私直接不收（v17）

证件号、银行卡号、密码/口令、精确住址（如「3 号楼 502 室」）在写入前就被拒绝，不做打码入库：
「记着他有身份证号」本身就是风险，没有画像价值。`--force` 可越过拦截，但打码规则随后仍会生效。

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
