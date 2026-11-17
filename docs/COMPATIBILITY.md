# 宿主兼容性（DSH / 通用 Agent）

> 目标：**换一个 DSH 版本、少一半宿主 API，插件也不崩**——缺什么就关掉什么，并在 `profile doctor` 里说清楚哪一项不可用、为什么。

## 1. 支持范围

| 项 | 值 |
| --- | --- |
| 声明范围 | `dsh.compat.hosts: ">=0.2.0"`（`package.json`） |
| 实际策略 | **能力探测**，不是版本号判断：启动时逐项探测宿主 API，能用就用，不能用就降级 |
| Node | `>= 20`（`engines.node`） |
| 独立运行 | 不需要宿主：CLI（`bin/profile.mjs`）与 MCP server（`mcp/server.mjs`）单独可跑 |

版本号只用于「说明我大概适配到哪一代」，**真正的判断依据永远是探测结果**：DSH 0.2.x 的多个 rc 之间 API 也有差异，写死版本号会误判。

## 2. 用到的宿主 API 与探测方式

| 能力 | 宿主 API | 探测 | 缺失后果 |
| --- | --- | --- | --- |
| 事件订阅 | `ctx.on('session/event')` | `typeof ctx.on === 'function'` + 注册是否抛 | 不采集对话与工具调用；`declare` / `import` / MCP 仍可用 |
| 画像注入 | `ctx.on('agent/pre-step')` | 同上（单独 try） | 不自动叠加画像；可手工把 `inject.md` 交给模型 |
| 面板数据 | `ctx.inject(['webServer'])` → `webServer.register` | 回调参数上有 `register` | 设置页读不到数据；页面本身还在，CLI 仍可查 |
| 面板鉴权 | `ctx.inject(['connection'])` → `connection.requestRejection` | 方法存在性 | 接口照常注册但**没有 cookie 校验**，仅靠端口不暴露；`.host.json` 里记为缺失 |
| 语义提取 | `ctx.llm.prepareCall` + `ctx.loader.import('@deepseek-ai/dsh-llm')` | 两处都探测，任一缺失即降级 | 不自动提炼；行为信号与手工条目仍工作 |
| 设置页页签 | 客户端 `ctx.slots.inject('settings.section')` | `slots.inject` / `slots.register` 都在才注册 | 设置页少一个「用户画像」页签；客户端 `apply` 静默返回，不抛 |
| 打包 | `dsh.bundle.patch` + `cordis.patch.yml` | 宿主 loader 读取 | 插件不会被加载（这是安装契约，不是运行时能力） |

`index.js` 顶部不声明任何硬依赖（`export const inject = []`）：把 `loader` 写成硬依赖时，没有该服务的宿主会**拒绝加载整个插件**，而降级本可以让它继续工作。

## 3. 事件名别名

不同版本对同一件事的命名不一致，插件先把别名收敛成规范名再分发（`EVENT_ALIASES`）：

| 规范名 | 接受的别名 |
| --- | --- |
| `tool/call` | `tool_call`、`toolCall`、`tool-call` |
| `tool/result` | `tool_result`、`toolResult`、`tool-result` |
| `turn/start` | `turn_start`、`turnStart` |
| `turn/end` | `turn_end`、`turnEnd` |
| `user/message` | `user_message`、`userMessage` |
| `assistant/message` | `assistant_message`、`assistantMessage` |
| `request/header` | `request_header`、`requestHeader` |

未识别的类型直接忽略（不抛、不记脏数据）。

## 4. 降级矩阵（缺什么 → 用户会看到什么）

| 缺失 | 采集 | 注入 | 设置页 | 智能提取 | 用户可见表现 |
| --- | --- | --- | --- | --- | --- |
| 全部正常 | ✅ | ✅ | ✅ | ✅ | 正常 |
| 无 `webServer` | ✅ | ✅ | ❌ | ✅ | 页签在，但打开是读不到数据；`profile panel` 正常 |
| 无 `connection` | ✅ | ✅ | ⚠️ 无鉴权 | ✅ | 功能可用；`.host.json` 标 `connection:false`，doctor 里明写 |
| 无 `llm` | ✅ | ✅ | ✅ | ❌ | 只有行为信号 + 手工条目 |
| 无 `agent/pre-step` | ✅ | ❌ | ✅ | ✅ | 画像不会自动进上下文 |
| 无 `session/event` | ❌ | ✅ | ✅ | ❌ | 不记录；只能用 CLI / MCP 维护 |
| 无客户端 `slots` | ✅ | ✅ | ❌ 页签缺失 | ✅ | 设置页没有「用户画像」项 |

## 5. `.host.json`：宿主到底给了什么

插件加载时把探测结果写到 `$DSH_USER_PROFILE_HOME/.host.json`（默认 `~/.dsh/user-profile/.host.json`）：

```json
{
  "at": "2026-11-17T13:20:00.000Z",
  "plugin": "dsh-user-profile",
  "node": "24.22.2",
  "plugin": "cordis",
  "sessionEvents": true,
  "preStep": true,
  "webServer": true,
  "connection": true,
  "llm": true,
  "loader": true,
  "hooksFailed": []
}
```

- 不含任何凭据、路径或画像内容。
- 只在内容变化时重写（避免频繁 IO）。
- 注册失败的主题会出现在 `hooksFailed` 里，例如 `["agent/pre-step: unknown hook"]`。

## 6. 一条命令看清现状

```bash
node bin/profile.mjs doctor        # 人话版
node bin/profile.mjs doctor --json # 机器版（caps / home / node）
```

输出示例（缺 llm 与面板路由时）：

```
插件          dsh-user-profile v0.3.0
Node          24.22.2
宿主记录       2026-11-17T13:20:00.000Z（plugin=cordis，node=24.22.2）
采集           可用
注入           可用
面板路由        缺失 → 设置页里的「用户画像」会读不到数据（页面本身还在）
面板鉴权        缺失 → 面板接口没有 cookie 校验，仅限本机访问时依靠端口不暴露
智能提取        缺失 → 不会自动从对话里提炼条目，新偏好需手工 declare
```

## 7. 兼容性怎么被验证

| 测试 | 覆盖 |
| --- | --- |
| `tests/compat.mjs` | 最简宿主（只有 `ctx.on`）、缺 `agent/pre-step`、连 `ctx.on` 都没有、旧事件名、`pre-step` 不传 `next` —— 全部要求「不抛 + 降级记录正确 + 别名事件照样统计」 |
| `tests/audit-4.mjs` | 能力文件位置与洁净度、`doctor` 人话/JSON、导出契约、兼容层没踩坏注入口径、别名不双计、畸形事件、MCP 协议、旧配置迁移、面板字段 |
| `tests/render.mjs` | 客户端 bundle 在**没有 `slots` 的宿主**上 `apply` 不抛 |

## 8. 已知的不可兼容项（说清楚，不装作能）

1. **宿主没有 `agent/pre-step`**：插件无法在任何一步之前插入消息，自动叠加做不到。此时只能靠 MCP 的 `profile_get`（需要宿主支持 MCP）或手工。
2. **宿主没有客户端模块加载器**：设置页不存在。这不是降级能补的——UI 只能由宿主提供槽位。
3. **宿主把 `session` 事件里的 id 去掉**：`provenance.session` 记不到具体会话，只能记时间与摘录（其余字段仍在）。
4. **老版本 dsh 的 `ctx.on` 会为未知主题抛错**：已按主题逐个 try，失败的记入 `hooksFailed`，不影响其它能力。
