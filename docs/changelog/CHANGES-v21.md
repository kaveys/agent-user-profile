# CHANGES v21 — 配置不再「能改但看不到」

## 起因

第六轮排查（`tests/audit-6.mjs`，25 项）没有发现真 bug，于是把 `tests/audit-5.mjs` 的 A2 从「手写几个关键路径」升级成 **双向核对**：

- A1：`panel.settings` 里的每个叶子路径都必须能用 `set` 改；
- A2：`set list` 支持的每个键都必须出现在 `panel.settings` 的叶子路径里。

只查一个方向时，漂移可以躲在另一个方向。

## 查出来的东西

A2 第一次输出 13 个「能改、但面板看不到」的键：

```
enabled
build.includeObservedItems
extract.provider
extract.model
extract.minInputChars
extract.maxInputChars
extract.requireGlobal
extract.maxOutputTokens
extract.debugLog
capture.turnSignals
capture.toolNames
capture.userText
backup.webdav.timeoutMs
```

再往前一步，还有 `inject.relevanceFloor`（`explain` 用来判断「这条与本轮有关吗」的门槛，默认 0.12）——它既不在 `SET_SPEC`，也不在 payload 里，等于写死在代码里，用户看不见也改不了。

这些键都不是装饰：`extract.provider` / `extract.model` 决定提炼用哪个模型，`capture.*` 决定采什么，`build.includeObservedItems` 决定要不要把工具统计写进画像。改不了，就等于插件替用户做了决定。

## 修法

1. `bin/profile.mjs` 的 `SET_SPEC` 补 `inject.relevanceFloor`（`type:'number'`, 0..1），`DEFAULT_CONFIG.inject` 补 `relevanceFloor: 0.12`。
2. `bin/profile.mjs` 的 `cmdPanel` payload 把上面 13 个键全部暴露出来：`settings.enabled`、`settings.build.includeObservedItems`、`settings.capture.{turnText,turnSignals,toolNames,userText}`、`settings.extract.{provider,model,minInputChars,maxInputChars,requireGlobal,maxOutputTokens,debugLog}`、`settings.backup.webdav.timeoutMs`。
3. `client.js` 的 `SETTINGS_FORM` 只加三项：`extract.provider`（用哪个模型提供方）、`extract.model`（用哪个模型）、`extract.maxInputChars`（最多读多少字）；「更新与隐私」组加数字输入「相关性门槛」。其余键留在 payload，避免设置页变成调参面板。

## 一次踩坑（值得记）

第一版补丁失败两次：`settings` 里本来就有 `build` / `extract` / `capture` 三块（`bin/profile.mjs:1745` 起），而我把新块插在 `settings: {` 之后（`:1709`）——**同一个对象里出现重复键，后写的覆盖前面的**，我加的字段全被老块盖掉。

现象很具体：`capture.turnText` 在，`capture.turnSignals` 不在。判据是同名键在同一个对象字面量里出现了两次。

正确做法是把新字段并进已有的三块，而不是新起同名的块。已加 `_dupcheck.mjs` 式的唯一性检查思路进文档：改 payload 前先确认 `build:` / `capture:` / `extract:` 各只出现一次。

## 验证

| 套件 | 结果 |
| --- | --- |
| `node --check bin/profile.mjs / client.js` | 0 |
| `tests/selftest.mjs` | 全部通过 |
| `tests/audit-1.mjs` | 33/33 |
| `tests/audit-2.mjs` | 34/34 |
| `tests/audit-3.mjs` | 51/51 |
| `tests/audit-4.mjs` | 全部通过 |
| `tests/compat.mjs` | 全部通过 |
| `tests/audit-5.mjs` | **31/31**（A2 现在是双向核对，`enabled` 也纳入） |
| `tests/audit-6.mjs` | 25/25 |
| `tests/render.mjs` | 全部通过 |
| `scripts/verify-install.mjs` | 13/13 |

真实环境抽查：`set inject.relevanceFloor 0.2` → `panel.settings.inject.relevanceFloor === 0.2` → 改回 0.12 正常；`panel.settings.extract.provider` 为空串（跟随会话模型），与 `set list` 一致。

## 生效方式

- `bin/profile.mjs` 改动立即生效（每次请求现起 CLI 子进程）。
- `client.js` 改动刷新设置页即可（HMR）。
- `index.js` 未改，本轮不需要重启 dsh。

## 仍未做

- `capture.*` 三个开关没有面板入口，只能 `profile set`。理由：它们决定「采什么」，属于诊断用途，放在设置页会诱导用户关掉采集再抱怨画像不长。
- `extract.debugLog` 同理，只保证 `set` 能改、`panel` 能读。
- 双向核对目前只覆盖 `settings` 这一层；`stats` / `health` 这类派生块的字段名漂移还没有同类守卫。
