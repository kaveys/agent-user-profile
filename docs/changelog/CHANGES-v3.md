# v3 变更（本次）

## 1. 清单守护搬回它该在的地方

上一版把「任务面板更新不及时」的提醒逻辑塞进了画像插件（`todoGuard`），这是越界：
画像插件管的是「你是谁」，不是「清单写没写」。现已**从画像插件删干净**，改为直接修补本机原有插件：

```
<home>\.dsh\plugins\dsh-todo-sync\index.js      ← v2 已写入
<home>\.dsh\plugins\dsh-todo-sync\index.js.orig-2026-11-15   ← v1 原样备份
```

`dsh-todo-sync` v2 修的五件事：

1. 计数改用 `tool/call`（`tool/result` 并行时会合并 → 计数偏小 → 够不到阈值）；
2. `threshold` 4 → 2；
3. 提醒点名当前 `in_progress` 条目（只说"该更新了"不会动手）；
4. 旧提醒**替换**而不是「发现已存在就 return」（v1 因此每轮只会提醒一次）；
5. 每轮额度 `maxNudgesPerTurn`（默认 8）防刷屏。

画像插件里 `DEFAULT_CONFIG.todoGuard` / `readConfig.todoGuard` / `guardBlock` / `todoState` /
`case 'todo/write'` / pre-step 的守护段与 `kept` 过滤**全部删除**，`panel` 也不再上报 `todoGuard`。

## 2. 画像数据补齐 CRUD

原来只能 `declare` + `forget --id`，加错了只能去翻 JSONL。新增：

| 命令 | 作用 |
|---|---|
| `declare --dim --fact [--key --core --pending]` | 新增一条（原有） |
| `edit --id <id> [--fact --dim --key --confidence --core]` | 改一条：就地改写，旧值进 `changelog.jsonl`，`at` 刷新为修改时间以保证冲突裁决时算「最新」 |
| `forget --id <id> \| --key <key> \| --dim <维度> \| --all [--pending]` | 删一条 / 按 key / 按维度 / 全清（`--pending` 作用于候选队列） |
| `import --file <path.json> [--pending]` | 批量导入：JSON 数组或 `{ items: [...] }`，字段 `{dim,fact,key?,confidence?,source?,core?}`，非法维度/空内容跳过并计数 |
| `dims list \| add <id> <标签> \| remove <id>` | 自定义维度：`add` 会把 id 追加进 `config.dimensions`、标签写进 `config.dimensionLabels`，`build` 用标签渲染章节名 |

删除与修改都只动 `declarations.jsonl`（append-only 的写入口径保持不变：`edit` 先改记录再整表重写，
并把 before/after 追加进 changelog，仍可回溯）。

## 3. 设置页面板可以写

新增 host 路由 `POST /user-profile/action`（`ACTION_ROUTE = '/user-profile/action'`），
与 `GET /user-profile/panel.json` 分开：**读走 GET，写走 POST**。

动作表（`ACTIONS`，每个都把参数翻译成一次 CLI 调用，写入语义与命令行完全一致）：

- `declare`：`{dim, fact, key?, core?, pending?}`
- `forget`：`{id | key | dim | all, pending?}`
- `edit`：`{id, fact?, dim?, key?, confidence?, core?}`
- `review`：`{accept | reject}`
- `set`：`{key, value}`
- `dims`：`{add?, remove?, id?, label?}`
- `build`：重建画像

client.js 对应新增：`AddForm`（维度下拉 + 内容输入 + 核心/待审勾选 + 添加按钮）、
`ItemRow` 的「删除」（二次确认，4 秒后自动取消 arm）、待审候选的「接受 / 丢弃」按钮、
`postAction()` 统一出口 + 结果提示行（失败原样显示 CLI 的校验信息）。
写操作成功后清 `panelCache`，下一次 GET 立刻反映新状态。

面板新增的 `dimensions` 字段（`{id, label}[]`）专供「新增」下拉，含自定义维度。

## 4. 安装

改动在**工作区副本**里，安装副本要同步才生效：

```bash
node "<repo>\scripts\register.mjs"
```

`register.mjs` 现在先做「源码同步」（逐文件比对内容，只写有差异的），再注册 patch、再建 junction。
然后**完全退出 DSH 再启动**（`cordis.patch.yml` 与 client bundle 只在启动时装载）。

## 5. 未验证项（诚实清单）

本轮环境的 shell 不可用（`pwsh` → `spawn EPERM`、`terminal_open` → `Cannot launch conpty`、
`grep` → `ripgrep launch failed`），只有 read/write/edit 可用，因此：

- 没有跑 `node --check`、`tests/selftest.mjs`、`verify-install.mjs`；
- 没有在设置页点过新增/删除/接受（面板改动未做真机验证）；
- `dsh-todo-sync` v2 未经运行时验证。

请在重启后按下面三条自查：

```bash
node "<home>\.dsh\plugins\dsh-user-profile\scripts\verify-install.mjs"
node "<home>\.dsh\plugins\dsh-user-profile\tests/selftest.mjs"
node "<home>\.dsh\plugins\dsh-user-profile\bin\profile.mjs" dims list
```
