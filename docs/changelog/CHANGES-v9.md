# v9 — UI 优化 + 恢复点

> 用户一句话：「UI优化」。
> 这次没有新功能野心，两件事：把界面做出「能长期用」的手感，以及补上「删错了怎么办」。

## 一、先说开工时撞到的事

打开注入块发现 `画像版本 v68 … 共 0 条` —— 画像又被清空了。

`snapshots/` 里有 11 份 `declarations-forget-*`，最新几份是 **1 条 → 11 条** 的阶梯，`changelog` 记着 `revision 65→68`、`declarations 3→0`：又是面板「批量删除」逐条发请求，删一条就 rebuild 一次。

已用快照恢复：`profile import --file .../snapshots/declarations-forget-1794755236060.jsonl` → **11 条，画像 v69**。

顺带把「删错了能不能救回来」变成产品能力，而不是我临时写脚本。

## 二、恢复点（新的第五个能力）

### 数据层（`bin/profile.mjs`）

| 函数 | 作用 |
| --- | --- |
| `listSnapshots(limit = 20)` | 列 `snapshots/declarations-*.jsonl` → `{name, tag, count, last, bytes}`，按名字倒序（时间戳等宽，字典序即时间序） |
| `cmdSnapshots` | `profile snapshots`，文本列出新的在前 |
| `cmdRestore` | `profile restore --name <文件>`：先给当前状态再留一份快照，再覆盖写回，changelog 记 `kind:'restore'`，最后 rebuild |

- 快照在**每次删除前**自动生成（`snapshotDeclarations('forget')`，最多保留 20 份）。
- `restore` 自身也留快照（tag=`restore`）—— 恢复错了还能再退回来。
- 面板 payload 新增 `snapshots`，取最近 12 份。
- `MUTATING` 加 `restore`，与其它改写型命令共用同一把锁。

### Host 层（`index.js`）

新增 action `restore`：先正则校验快照名（`/^declarations-[\w.-]+\.jsonl$/`，挡路径穿越），再 `runCli(['restore','--name',name])`。

### 界面

「备份与重置」页签顶部新增 **恢复点** 区：每行 `删除前 / 恢复前 · N 条` + 等宽文件名 + 「恢复」按钮；两点确认（点一次变「再点一次覆盖当前」，5 秒不点自动取消）。

## 三、界面优化

手感问题只有一类：**没有样式表，所有状态都得自己算**。所以改动集中在「状态可见性」：

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 顶部 | 一行灰字 `v69 · ready · 11 条` | **状态胶囊**（圆点+人话+条数）+ `v69 · 11 条已确认 · 按优先级排列` + 「刷新」「立即更新」两个按钮 |
| 页签 | 数字拼进文案（`待审 3`） | 文案不变，数字改成独立小胶囊（`tabCount`），页签条 `sticky` 吸顶 |
| 按钮 | 纯文字块 | `Btn` 组件：hover 变色、`transition 120ms`、primary/danger 两态、disabled 降透明度 |
| 提示条 | 一直挂着 | 左侧 2px 语义色边（成功绿 / 失败红）+ `×` 关闭 + **8 秒自动消失** |
| 加载 | 一行「正在读取画像…」 | 4 条骨架屏（`skeleton`） |
| 出错 | 一行红字 | 卡片：标题「读不到画像数据」+ 详情 + 重试 |
| 危险操作 | 和普通表单混在一起 | 收进 `dangerZone`（淡警示底） |

顺手修掉一处旧文案：导入示例里的维度名 `preferences` 早已废弃，改成 `taste`，并注明「也认一行一条的 JSONL」。

## 四、回归

| 检查 | 结果 |
| --- | --- |
| `node --check` index.js / client.js / bin/profile.mjs | 0 |
| `tests/render.mjs` | **31 项全通过**（新增：payload 带 snapshots、备份页有「恢复点」、外壳有状态行与「立即更新」） |
| `tests/selftest.mjs` | 全通过（含并发写、陈旧锁、漂移、去重、提炼器复用 key、规定层） |
| `verify-install.mjs` | 12 项全通过 |
| `GET /user-profile/panel.json` | 200 · 9324 字节 · 14 键 · `snapshots=12` · `items=11` · `rev=69` |

写测试时踩到一个真 bug：`snapshots.map(...)` 那段少/多一个右括号，`snap` 跑到了 `map` 外面 → `ReferenceError: snap is not defined`。`node --check` 抓不到（语法合法），是 `tests/render.mjs` 渲染真实组件才暴露的 —— 这也是当初写这个烟测工具的理由。

## 五、怎么生效

| 改了什么 | 要做什么 |
| --- | --- |
| `client.js`（界面） | **刷新设置页**即可（bundle 走模块加载，重新取文件） |
| `bin/profile.mjs`（CLI） | 立即生效（每次请求现起子进程） |
| `index.js`（新增 `restore` action） | **必须重启 dsh** —— 实测 `POST /user-profile/action {"action":"restore"}` 现在仍返回 `400 未知动作 restore`，说明跑着的是旧 index.js |

重启：双击 `scripts/restart-dsh.cmd`。

## 六、没做的

- 快照列表只显示最近 12 份（磁盘上最多 20 份），更老的仍需 `profile snapshots` 用命令行看。
- 批量删除仍然是逐条 `forget`（每次一快照、一次 rebuild）。候选改法是一次性 `forget --id <a,b,c>` + 单次 rebuild，但需要先确认面板那个「批量删除」到底是谁触发的（这几次清空都不是我点的，怀疑前端误触或旧 bundle 的按钮状态，尚未定位）。
- 快照没有大小上限保护：条目暴涨时每份快照都会变大，20 份可能占几十 MB。
