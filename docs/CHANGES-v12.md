# v12 变更记录：只有「可能对全局有用」的信息才进画像

需求原话（2026-11-16）：

> 只有当可能确实需要应用到全局的画像才会被录入，这一点可以参考豆包的画像记忆。
>
> 做这个的目的，只是为了帮助 Agent 更好的了解用户，做出更加个性化的内容。

## 一、为什么改

v11 之前的准入标准是「跨会话可复用」。这个标准太松：它会放过「这个仓库用 pnpm」「这次先别动配置」这类**只对当前项目/当前这一轮成立**的信息。这些条目一旦进了全局画像，就会在无关任务里被当成用户特征注入，反而让产出更不像用户想要的。

新的准入标准只有一句：**知道它，会不会让我下次做出来的东西更像他要的。**
跨任务不成立、或者知道了也不会改变做法的，一律不记。

## 二、三道准入检查（写进提炼提示）

提炼器在写每一条之前要过三关，三关全过才写：

| 检查 | 问题 | 反例 |
| --- | --- | --- |
| 跨任务 | 换一个毫不相关的任务，这条还成立吗？ | 「这次要改 client.js」「这轮先不要动配置」 |
| 有用 | 知道它会不会改变我下次的做法？ | 「这台机器是 Windows」（要落成「用户在 Windows 上开发插件」才可用） |
| 归属 | 说的是用户本人，还是这次的任务/文件/代码/报错/时间点？ | 「报错是 EPERM」「端口 37442」 |

一律不要：本次/这一轮/当前任务的细节、文件名与路径、端口与版本号、报错原文、命令、一次性要求、临时约定。

## 三、scope 字段（两级落点）

- `global`：跨任务都成立，进全局画像。
- `project`：只在这个项目/工作区成立，**只在同一工作区生效**，不进全局画像。
- 提示里明确要求：**拿不准就写 `project`** —— 宁可少记，也不要把项目细节写进用户画像。

## 四、代码改动

### `index.js`

1. `EXTRACT_SYSTEM` 重写：开头加目的句（画像只有一个用途 —— 让下次做事更贴合这个人），随后是三道检查、排除清单、scope 规则；示例 JSON 增 `"scope":"global"`。
2. 新增 `const SESSION_SCOPED = /(本次|这一轮|这轮|当前任务|刚才那|这个插件|这个文件|这个仓库|该文件|上面那个|临时|待会)/` —— 便宜兜底：模型偶尔会把项目细节标成 global，命中就降级成 project。
3. `parseFacts` 每条算出 `scope`：`declared = item.scope === 'project' ? 'project' : 'global'`，再与 `SESSION_SCOPED` 取交集（global 且命中 → project）。
4. `writeFacts(facts, minConfidence, requireGlobal = true)`：`requireGlobal` 打开时，`scope !== 'global'` 的直接丢弃并记日志（`fact dropped (project-scoped)`）；写盘时补 `--scope global|project`。
5. `DEFAULT_CONFIG.extract` 新增 `requireGlobal: true`；调用处传 `ex.requireGlobal !== false`。
6. `PLUGIN_POLICY` 第 5 条改写：只把「换个任务仍然成立、而且会改变下次做法」的偏好或红线记候选；本次任务细节、路径、端口版本、一次性要求一律不记。

### `bin/profile.mjs`

无改动 —— `declare --scope` 与 `build` 的作用域过滤（`inScope`）在 v2 就已经有了，这次只是把提炼端对齐到它。

## 五、验证

| 工具 | 结果 |
| --- | --- |
| `node --check index.js / _selftest.mjs / _e2e.mjs` | 通过 |
| `_selftest.mjs` | 全部通过（新增 4 条：project 不写入、含「本次」的 global 被降级、提示含三道检查、提示要求 scope 且以 project 兜底） |
| `_e2e.mjs` | **34 / 34**（新增「declare --scope project 只在当前工作区生效」：project 条目必须带 scopeId、全局条目不受影响、清理后条目数回到原位） |
| `_render.mjs` | 全部通过 |
| `scripts/verify-install.mjs` | 12 / 12 |

## 六、生效方式

- `bin/profile.mjs`：改完即生效（每次请求现起子进程）。
- `index.js`：**需要重启 dsh** 才会用新的提炼提示与准入门槛。
- `client.js`：本次未改。

## 七、当前数据状态

真实画像已被手动删除到 0 条（v131，2026-11-16 00:57 那次批量删除）。要找回：

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-user-profile"
node bin\profile.mjs restore --name declarations-forget-1794761856091.jsonl
```

那份快照含删除前的全部 5 条。

## 八、未做

- 没有做「项目级画像」的面板视图：`scope: project` 的条目目前只能靠 CLI `--all-scopes` 查看，面板只显示全局。要做的话得在面板加一个作用域筛选。
- 提炼质量本身无法在本会话自证（取决于真实模型输出），只能用 `extract.debugLog` 打开日志观察。

## 九、附：权重可手动修改（v12.1）

需求：「用户要可以修改权重」。

- **CLI**：`edit --id <id> --weight 0.75`（`--weight` 是 `--confidence` 的别名，两套词都认；权重就是该条的 confidence，范围 0–1）。
- **面板 · 条目页**：权重列每行右侧有 `－` / `＋` 步进（每次 0.1，夹在 0.1–1.0，到边界自动置灰）；等级（高/中/低）与权重条随之刷新。
- **面板 · 行内编辑**：编辑态新增「权重」数字输入（0.1–1，步进 0.05），可精确设定。
- 兼容性：面板同时发送 `weight` 与 `confidence` 两个字段，所以**旧宿主（未重启）也能立即改权重**；重启后才会认 `--weight` 这个别名本身。

验证：
- `_e2e.mjs` 35/35（新增「edit --weight 改权重」：写入 confidence、可反复调整）；
- `_render.mjs` 全通过（新增「条目页有权重加减按钮」「显示权重等级」）；
- 真机往返：设置页 → 用户画像 → 条目 → 第 6 行「沟通与表达」点 `＋`，`declarations.jsonl` 里该条 confidence 由 0.8 → 0.9；再用 CLI 改回 0.8，面板随之刷新。


## 十、定位与命名（v12.2，2026-11-16）

**改的是说法和门牌，不是功能。** 代码零改动，只动元数据与文档。

| 项 | 旧 | 新 | 为什么 |
| --- | --- | --- | --- |
| 仓库名 | `dsh-user-profile` | `agent-user-profile` | 两个搜索热词 `agent` + `user-profile`；`dsh-*` 只有生态内的人搜 |
| 定位 | DSH 插件：生成用户画像 | Agent 的用户画像层（DSH 优先实现） | 核心与宿主解耦、CLI 可单跑，可达人群放大 |
| README 首屏 | 结构树 + 安装步骤 | 一句话定位 + 这是什么/不是什么 + 三个独占点 + 两屏截图 + 不装宿主也能跑 | 首屏决定 star |
| 元数据 | 无 keywords / license / repository | 11 个 keywords、MIT、homepage/repository/bugs（`OWNER` 占位） | 可被搜到、可被信任 |

**刻意不改**：npm/插件包名仍是 `dsh-user-profile`。它是 DSH 适配器名，宿主 loader 按裸包名解析；改名要同时动 `cordis.patch.yml` 的 `insert.name`、`<profile>/node_modules/dsh-user-profile` 链接、`dsh.client` 声明，缺一样就静默不加载。已装实例不能为了改名而断。

**新增文件**：`LICENSE`（MIT）、`.gitignore`、`docs/POSITIONING.md`（定位演进 / 命名表 / 搜索词矩阵 / 与 5 个同类项目的坐标 / 核心与适配器分界 / 移植路线）、`docs/screenshots/*` 改为 ASCII 文件名（GitHub 上 CJK 链接容易坏）。

**未做（用户明确跳过）**：首屏 GIF。
