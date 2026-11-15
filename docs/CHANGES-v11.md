# CHANGES v11 — 功能自检：33 项端到端 + 7 个页签真机

> 起因：用户「再次完善，要实际检测每一个功能都能够正常使用」。
> 这一版不是凭「跑过单测」交差，而是把插件当黑盒，一条条真调：CLI 子进程、真实面板 HTTP 路由、真实设置页 UI。

## 一、新增的自检工具 `_e2e.mjs`

```bash
node _e2e.mjs      # 33 项，约 20 秒
```

分两段跑，互不干扰：

| 段 | 打到哪 | 数据 |
| --- | --- | --- |
| A 段（17 项） | `bin/profile.mjs` 全部子命令，`spawnSync` 起真进程 | 临时目录 `DSH_USER_PROFILE_HOME`，**不碰真实画像** |
| B 段（16 项） | 运行中的 `/user-profile/panel.json` 与 `/user-profile/action` | 真实数据，用带时间戳的 `e2e-<ts>` 标记，跑完自己清掉并核对条数 |

A 段每个用例都断言**副作用**，不只看退出码：

| 用例 | 断言什么 |
| --- | --- |
| `init` | config/declarations/pending/changelog 四件齐备，`schemaVersion = 4` |
| `declare` | 声明 +1，且 `profile.json` 已生成（证明 rebuild 真的跑了） |
| `declare --pending` | 进 `pending.jsonl` 而不是声明表 |
| `review` 列/接受/丢弃 | 接受后声明 +1 且待审清零；丢弃后声明不变 |
| `edit` | 维度/置信度真的改了，且不产生冲突历史 |
| `merge` | 并掉一条，`mergedFrom` 记录被并方 |
| `forget --id/--key/--dim/--all` | 四种筛选各删对目标 |
| `forget` 无匹配 | **非零退出且报「没有匹配」**（不静默成功） |
| `import` JSON 数组 / JSONL 快照 | 合法条目进、非法维度跳过、老维度名被重归类 |
| `dims list/add/remove/reclassify` | 维度写进 config 又能移除；非法 id 报错 |
| `observe` | 当月观测文件出现 `"kind":"turn"` |
| `build` | 三份产物齐全；`inject.md` 带标题且**不再含**使用规矩 |
| `show`/`status`/`panel` | 三种读法都有内容；panel 有 10 个关键键、**不再有** `paths` |
| `set` | 点路径写进 config 并落盘 |
| `snapshots`/`restore` | 全删后能整体回滚 |
| `export` | 目标目录非空 |
| `reset` | 声明清零、`archive/` 有归档 |

B 段逐个动作打真实路由：`build`、`declare`、`edit`、`review`、`set`、`settings`、`dims add/remove`、`importText`、`merge`、`export`、`restore`、`reset`、未知动作，并覆盖三条**错误分支**：

- `restore` 传 `../../etc/passwd` → `ok:false`（路径穿越被白名单挡住）
- `reset` 缺 `confirm` → `ok:false`（危险动作要显式确认）
- 未知 action → **HTTP 400**
- 最后核对：测试条目已清空、条目数与自检前一致（±1）

## 二、自检抓到并修掉的真 bug

**`import` 会静默污染 `taste`。** 原来凡是维度名不认识的行，都交给 `classifyLegacy` 猜，猜不出来就落到 `taste` 兜底 —— 于是「拼错的维度名」「别的工具导出的脏数据」都会变成一条口味偏好。现在只对**已知的老维度名**（`preferences`/`expertise`/`workflow`/`design`/`process`/`tools`/`tooling`/`planning`/`hobby`/`hobbies`/`school`/`education`）做重归类，其余一律计入「跳过 N 条」。

对应断言：给 `{items:[合法一条, dim:'bad-dim' 一条]}`，必须只进 1 条。

## 三、七个页签的真机核对

用 UIA `invoke` 逐个点（坐标点击对页签无效），每个页签截图留档：

| 页签 | 真机看到的东西 |
| --- | --- |
| 概览 | 4 张指标（13 条 / 13 条已确认 / 0 待确认 / 1 分钟前）、画像分布 5 个大类、优先级分布 高5·中6·低2、当前策略 5 行 |
| 条目 | 搜索 + 维度过滤 + 排序 + 13/13 条、每行 编辑/设核心/删除、核心与已确认徽章、权重显示 高/中 |
| 待审 | 空态文案「低置信度的提炼结果会先落到这里」 |
| 冲突与历史 | 「冲突判定 · 0 条」「历史留档 · 0 条」两段空态 |
| 维度 | 10 个大类（id + 说明 + 条目数 + 删除）、底部「新增维度」表单 |
| 设置 | 4 组 12 项：开关、下拉、数字输入、每个字段一句人话解释；底部粘性保存条只在改动后出现 |
| 备份与重置 | 恢复点 5 份 + 「展开全部 12 份」、导出备份、批量导入 textarea |

截图：`docs/screenshots/01-overview.png` … `07-backup.png`。

## 四、回归

- `node --check` index.js / client.js / bin/profile.mjs / _selftest.mjs / _render.mjs 全 0
- `_e2e.mjs` **33 / 33 通过**
- `_render.mjs` 渲染烟测 **31 项**通过（用的是真实 CLI 输出的 panel payload，不是假数据）
- `_selftest.mjs` 全部通过、`scripts/verify-install.mjs` **12 项**通过
- `scripts/register.mjs` 同步安装副本，`_e2e.mjs` 已加入 SYNC 列表

## 五、这一轮验证不到的两件事（诚实记录）

1. **pre-step 注入**：改 `index.js` 要重启 dsh 才会进 pre-step，而重启会杀掉当前会话，所以只能在下次会话里看注入块是否正确（本轮对话开头的注入块本身就是它工作的证据）。
2. **真实模型提炼**：`ctx.llm` 这条路依赖运行中的宿主。单测里用假 llm 覆盖了「解析 → 写盘 → 重建」的完整链路，但真实模型的输出质量只能在对话里观察（本轮画像里「含模型提炼 9 条」就是这么来的）。
