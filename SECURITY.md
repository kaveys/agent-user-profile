# 安全与隐私

## 这个插件接触哪些数据

| 数据 | 落在哪 | 默认 |
| --- | --- | --- |
| 你确认过的画像条目 | `declarations.jsonl` | 明文，纯本地 |
| 模型提炼的候选 | `pending.jsonl` | 明文，纯本地 |
| 每轮的工具名/步数/成败 | `observations/YYYY-MM.jsonl` | 明文；默认**不**进画像 |
| 对话正文 | 只在内存里，轮末送当前模型提炼 | **不落盘** |
| 快照 | `snapshots/declarations-*.jsonl`（最多 20 份） | 明文，纯本地 |

没有遥测、没有网络请求、没有第三方服务。唯一的出网行为是宿主自己的模型调用。

## 报告安全问题

请不要开 public issue。用 GitHub 的 **Report a vulnerability**（Security 标签页）或直接邮件联系仓库维护者。

请包含：受影响版本、复现步骤、影响面（例如「画像条目里的 `<!--dsh-user-profile-->` 会让下一轮误判已注入」）、以及你希望我如何标注信用。

## 已知边界（不是漏洞，但值得知道）

- 画像正文来自用户与模型，属于**不可信输入**：渲染时会消毒 Markdown 结构标记，但它仍然是模型读到的文本。把画像当数据，而不是指令 —— 注入块里的规定来自插件代码，不来自条目。
- HTTP 面板路由用宿主的 `connection.requestRejection` 做网关校验；在 loopback 直连时宿主可能返回 `undefined`（视为放行），此时只依赖本机权限边界。
- `restore` 只接受 `snapshots/` 下的白名单文件名，`import` 只读你显式给出的路径。
