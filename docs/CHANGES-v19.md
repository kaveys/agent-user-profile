# v19：宿主兼容层（能力探测 + 降级 + doctor）

> 诉求原文：**「要让插件兼容所有 dsh 的宿主版本，然后再检查修复 bug」**
> 版本：插件 `0.3.0`（上一版 `0.2.0`）；`package.json` 新增 `dsh.compat = { hosts: ">=0.2.0", strategy: "capability-probe" }`。

## 1. 一句话结论

不再假设宿主一定有什么：启动时逐项探测，**能用就用、不能用就关掉对应功能，并把结果写进 `.host.json`**，由 `profile doctor` 说清「这一项现在不可用，会导致什么」。

## 2. 兼容层做了什么

| 改动 | 位置 | 为什么 |
| --- | --- | --- |
| `caps` 能力表 + `.host.json` 落盘 | `index.js` `writeHostCaps()` | 降级不能只写在日志里（用户在 GUI 里看不到 stdout），必须落到用户能查的地方 |
| `onSafe(topic, handler, flag)` | `index.js` | 老宿主的 `ctx.on` 对未知主题会抛错；逐个 try，失败的记进 `hooksFailed`，不拖垮整个插件 |
| `agent/pre-step` 支持不传 `next` | `index.js` | 有的版本把它当纯通知；没有 `next` 时按「不拦不改」处理，而不是 `TypeError` |
| `EVENT_ALIASES` + `canonicalEventType` | `index.js` | `tool_call` / `tool-call` / `tool/call` 是同一件事，别名不该被当成脏数据丢弃 |
| `export const inject = []` | `index.js` | 原来写 `['loader']` 是**硬依赖**：宿主没有 loader 时插件会被拒绝加载，而降级本可以继续跑 |
| 客户端 `apply` 能力判断 + try | `client.js` | 没有 `slots` 的宿主里，注册设置页会抛；抛出去会带崩整个设置页，而用户只是少一个页签 |
| 客户端 `inject = []` | `client.js` | 同上：不声明硬依赖，缺 `slots` 也能加载 bundle |
| `profile doctor` / `doctor --json` | `bin/profile.mjs` | 把 `.host.json` 翻译成「可用 / 缺失 → 后果」，并给出下一步（例如「正常启动一次 dsh」） |
| 缺少能力时的启动提示 | `index.js` 收尾 | 只列真正缺的项，全都有时一声不响 |

## 3. 这一轮抓到的真 bug（4 个）

1. **路径在模块加载时被固化**（最严重）
   `const readInjectMd = cached(p('inject.md'), …)`：`p(...)` 在模块加载那一刻就执行，把当时的 `DSH_USER_PROFILE_HOME` 冻进路径。之后改环境变量（测试隔离、切换 profile、MCP 子进程复用同一模块）**仍然读旧目录**——表现是「换了数据目录，注入的还是上一个用户的画像」。
   修法：`readInjectMd/readPortraitMd/readConfig/readPortrait` 全部改成「调用时才算路径 + 缓存按最终路径分桶」（`cachedText` / `cachedJson`）。
   发现方式：`_audit4.mjs` 在临时 HOME 里声明 3 条并注入，结果注入块里出现的是**真实画像 v268**。
2. **`export const inject = ['loader']` 是硬依赖**：缺 loader 的宿主会拒绝加载插件。改为 `[]`，运行时再探测 `ctx.loader.import`。
3. **客户端 `apply` 无 `slots` 时会抛**：老宿主没有 `settings.section` 槽位 → 整个设置页白屏。改为能力判断 + try/catch + 静默返回，`inject` 也不再声明 `slots`。
4. **`_render.mjs` 的 `inject = ['slots']` 断言**固化了旧契约（测试本身是错的，顺手改正为「不依赖任何 `@deepseek-ai/*` 客户端包」+「没有 slots 时 apply 不抛」）。

## 4. 测试

| 套件 | 数量 | 结果 |
| --- | --- | --- |
| `_compat.mjs`（新） | 11 | 全部通过 |
| `_audit4.mjs`（新） | 22 | 全部通过 |
| `_selftest.mjs` | — | 全部通过 |
| `_audit.mjs` | 33 | 全部通过 |
| `_audit2.mjs` | 34 | 全部通过 |
| `_audit3.mjs` | 51 | 全部通过 |
| `_render.mjs` | — | 全部通过 |
| `_e2e.mjs --cli-only` | 26 | 全部通过 |
| `scripts/verify-install.mjs` | 13 | 全部通过 |
| `node --check` | 13 文件 | 全部通过 |

`_audit4.mjs` 覆盖：能力文件写在 `$DSH_USER_PROFILE_HOME` 且不含凭据、`doctor` 人话/JSON、无能力文件时给下一步、导出契约、兼容层没破坏注入语义（红线仍带入、无关条目被挡）、别名事件不双计、畸形事件不抛、MCP 10 工具 + 未知工具 `-32602`、v1 配置仍迁移到当前版本、`panel` 条目带 `partition`/`provenance`。

## 5. 生效方式

| 改动 | 何时生效 |
| --- | --- |
| `index.js`（能力探测、别名、提示） | **重启 dsh** 后写 `.host.json`，`profile doctor` 才有内容 |
| `client.js`（设置页防崩） | 刷新设置页（HMR 热重载） |
| `bin/profile.mjs`（`doctor`） | 立刻 |

## 6. 仍未做（诚实清单）

1. **没有真机跑过多个 DSH 版本**：本轮用「伪造残缺宿主」覆盖 API 缺失路径，但没有把 0.1.x / 0.3.x 实际装起来对跑。要更硬的结论，需要至少两个真实版本各装一次、各跑一遍 `doctor` + 面板。
2. **版本号矩阵未量化**：`dsh.compat.hosts: ">=0.2.0"` 是声明，不是实测边界。
3. **`connection` 缺失时的替代鉴权**：目前只留痕（`connection:false`），没有自建 token 校验；在多人共用一台机器的场景下需要补。
