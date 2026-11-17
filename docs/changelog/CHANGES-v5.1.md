# v5.1 — 修「删除功能失效」

## 现象

设置页「条目」里点删除，按钮变红（二次确认）再点，什么也没发生：条目还在，画像版本号也不动。

## 真因

删除**执行了**，只是删完没重算画像。

`cmdForget` 只做两件事：从 `declarations.jsonl` 里滤掉那条记录、把结果写回文件。而面板和注入读的都不是这份原始记录，而是 `build` 产出的 **`profile.json` / `profile.md` / `inject.md`** 快照。所以：

1. 数据层：记录真的没了；
2. 展示层：读的还是旧快照，条目原地不动；
3. 用户看到的就是「删除失效」。

面板里其它写操作（新增、编辑、合并、导入、接受待审、增删维度）是同一种结构，同一个坑——它们都只改数据、不改快照。

## 修法

`bin/profile.mjs` 新增一个唯一的收口函数：

```js
/**
 * 改完数据立刻重算画像。
 * 不重算的话面板与注入还停在旧快照，用户点「删除」会看到条目原地不动 —— 看起来就是「删除功能失效」。
 */
function rebuildQuietly() {
  try {
    cmdBuild({ flags: { 'all-scopes': true } })
  } catch (error) {
    process.stderr.write(`画像重建失败：${error?.message ?? error}（数据已改，可手动 build 刷新）\n`)
  }
}
```

在**每一个**改数据的命令末尾调用它：

| 命令 | 位置 | 回执文案 |
| --- | --- | --- |
| `declare` | 追加成功后 | 已记录 …（画像已刷新） |
| `forget` | 写回后 | 已删除 N 条…（画像已刷新） |
| `edit` | 写回后 | 已修改 …（画像已刷新） |
| `merge` | 写回后 | 已合并：保留…（画像已刷新） |
| `import` | 追加循环后 | 导入 N 条…；画像已刷新 |
| `review --accept/--reject` | 写回后 | 已接受/已丢弃 N 条候选（画像已刷新） |
| `dims add / remove` | `saveConfig` 后 | 已添加/已移除维度 … |

设计取舍：

- **放在 CLI 而不是面板**：命令行直接 `profile forget --id x` 也享受同样的即时一致性，不必记得「改完要 build」。
- **失败不抛**：重建失败只打一行 stderr，数据改动照样保留（宁可画像旧一点，也不能让用户刚写的改动因为重建失败而回滚）。
- **幂等**：`build` 本来就只是重算快照、`revision + 1`，重复调用无副作用。

## 顺带修掉的自测

`declare` 自带重建之后，原来那条「写了新数据但没 build → 面板标出画像过期」的用例制造不出漂移了（写即刷，`stale` 永远 false）。改成用 `appendFileSync` 直接往 `declarations.jsonl` 追加，模拟「数据已写、进程在 build 前被杀」——这才是 drift 检测真正要防的场景。

同时把「删除后立刻刷新」本身补成两条断言：

- `forget` 自己会重建画像（不靠外部 build）：条目数 6 → 5
- `forget` 的回执说「画像已刷新」

## 回归

| 套件 | 结果 |
| --- | --- |
| `node --check bin/profile.mjs / index.js / client.js / tests/selftest.mjs` | 全 0 |
| `tests/selftest.mjs` | 全部通过（含新增 2 条删除断言、并发写、陈旧锁、漂移、去重） |
| `tests/render.mjs` | 26 项全部通过 |
| `scripts/verify-install.mjs` | 12 项全部通过 |
| `scripts/register.mjs` | 已同步 2 个文件到 `~/.dsh/plugins/dsh-user-profile` |

## 生效方式

**不需要重启 dsh。** 修的是 `bin/profile.mjs`，它是每次请求现起的子进程；安装副本已同步，下一次点删除就走新代码。面板上如果还显示旧文案，点一下「刷新」或切页签重进。

（`index.js` 里新增的 `settings / merge / importText / export / reset` 那几个动作仍要重启 dsh 才注册——那是另一件事。）

## 未做

- 批量删除当前是逐条 `forget`，每条各重建一次；20 条就重建 20 次。数据量不大时无感，条目上千时应该改成一次 `forget --ids a,b,c` + 单次重建。
- 权重仍不可手动调（只能通过 `edit --confidence`）。
