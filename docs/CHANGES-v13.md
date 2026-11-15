# CHANGES v13：对抗式排查（2026-11-16）

用户要求「排查有没有BUG」。做法不是重跑既有用例，而是**新写一套专门挑边界的检查**（`_audit.mjs`，28 项），再按失败项修。

## 结论

跑出 **4 个真实缺陷**，全部已修，并全部写成常驻断言。

| # | 缺陷 | 为什么会掉进去 | 修法 |
| --- | --- | --- | --- |
| 1 | `dims remove <内置大类>` 成功执行 | 只做了 `filter`，没区分内置与自定义 | 内置十类一律拒绝，并给替代做法（`dims add` 加自定义） |
| 2 | 删除仍有条目的自定义大类 → 条目在磁盘上还在，但**从画像里静默消失** | `build` 只遍历 `config.dimensions`，维度没了 → 条目变孤儿；命令回执还写着"已有声明不会删除"，等于骗人 | 有条目就拒绝删除，并提示 `dims move` 或 `forget --dim`；新增 `dims move <from> <to>` 批量迁移（留快照 + changelog） |
| 3 | `set inject.maxChars abc / -5 / 0` 全部接受 | `cmdSet` 只做 `JSON.parse` 后直接赋值，没有任何类型/范围校验 | 新增 `SET_SPEC` 白名单（38 个键，带类型、范围、枚举、维度列表校验）+ `profile set list` 列出可用项 |
| 4 | `set inject.nope 1` 把垃圾键写进 `config.json` | 同上，路径不存在就现造对象 | 不在 `SET_SPEC` 的键一律 `die` |

顺手改的一处行为：`set` 默认只写配置、**不再顺带重建画像**（原实现会让「刚 init 的空目录」立刻多出 `profile.json`，把"从未生成"状态抹掉）。想立刻应用加 `--rebuild`，回执里也写明「下次生成画像/下一轮对话时生效」。

## 追加发现（写校验时带出来的）

加上白名单后，暴露出两个**序列化层面的隐患**，它们不会在旧代码里报错，但会在「面板保存」这条路上咬人：

| # | 隐患 | 修法 |
| --- | --- | --- |
| 5 | 宿主把配置项一律 `JSON.stringify`：数字 1600 变成字面量 `"1600"` 传给 CLI。旧 CLI 不校验所以看不出来；新校验下 `Number('"1600"')` 是 NaN，保存会直接失败 | `ACTIONS.settings` 改为：字符串原样传、数字/布尔 `String()`、只有数组/对象才 `JSON.stringify` |
| 6 | 维度列表只认逗号分隔，面板发的是 JSON 数组 `["constraints","taste"]` | `coerceSetting` 的 `dimensionList` 分支先试 `JSON.parse`，失败再按逗号/空白切分 |

这两条说明一件事：**给 CLI 加校验，等于给所有调用方（面板、脚本、将来的 MCP）补一遍类型契约**。加校验的时候必须连带检查"谁会以什么形态调用它"，否则修好旧故障会造出新故障。

## 通过检查的边界（值得记下来，防止以后改坏）

- `edit --dim nope` 被拒且原条目不变
- `merge --keep X --drop X` 被拒且不删数据；正常 merge 会把 drop 并进 keep 的 `mergedFrom`
- 空事实 / 全空白事实被拒；`--confidence 5` 被夹到 1
- 未 `init` 就 `panel` / `status`：输出可解析 JSON，不抛栈
- 导入重复 id 不产生重复条目
- `restore --name ../../../etc/passwd` 被拒
- 空库 `build`：`status=empty`，`inject.md` 不产出误导性正文
- `build --all-scopes` 才含别的项目条目；默认 `build` 不泄漏
- 10 分钟前的陈旧锁自愈；新鲜锁不硬闯（超时退出，不写半截）
- 极小预算（`maxChars=0` 被拒后夹到 200）下 `build` 不炸、产物非空

## 回归

```
_selftest.mjs   全通过
_e2e.mjs        35 / 35
_audit.mjs      32 / 32
_render.mjs     全通过
verify-install  12 / 12
```

## 未做 / 已知限制

- `_audit.mjs` 里"新鲜锁"用例只能验证「不硬闯」，没有验证等待 10 秒后放弃的精确时机。
- 面板 `settings` 一次提交多个键时，任一键非法会整体失败（这是有意的：不做部分成功），但 UI 只显示第一条错误。
- `dims move` 会把 `at/editedAt` 刷成当前时间，历史留档里的旧时间戳会被覆盖一层（`previousDim` 保留）。
