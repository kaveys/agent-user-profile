# v18：第三轮排查（逻辑错）

前两轮查的是「会不会崩、边界会不会出血」。这一轮换题目：**同一条数据在不同路径上是否得到同一个答案**。
新写 `tests/audit-3.mjs`（51 项），只问逻辑问题，不看异常。

## 判定标准

一条用例算「真 bug」要同时满足两点：

1. 用户能在正常使用中碰到（不是只有测试才构造得出来）；
2. 碰到的结果是「看到了假的成功」或「该生效的没生效」——崩了反而好发现。

按这个标准，本轮 6 个真 bug、4 个是测试自己写错。

## 六个真 bug

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 同一句话声明两次，`declarations.jsonl` 多一条 | `cmdDeclare` 注释写「第二遍会更新那一条」，实现只有 `appendJsonl` | 写入端先按 `dim+key+scope+scopeId+fact` 找同一条，命中就原地刷新 `at/confidence` 并回执「已更新（原来是同一条）」 |
| 2 | 待审为空时点「全部接受」报错 | `cmdReview` 对 `--accept all` 也走 `picked.length === 0 → die` | `target === 'all'` 空队列改成 no-op：「没有待审候选，无需处理」 |
| 3 | 接受候选时可能留下两条一模一样 | accept 直接 `appendJsonl`，不看已有声明 | 按 `dim|key|fact` 去重，跳过的条数在回执里说明 |
| 4 | MCP 调用未知工具返回 `{"result":{}}` | `callTool` 末尾没有兜底分支，返回 `undefined` | 分发处先校验 `TOOLS` 白名单，不在其中回 `-32602 未知工具` |
| 5 | `edit --fact` 改成身份证号会被打码后写入 | `cmdEdit` 先 `redactWithCount` 再 `assertValid`，`blockedPrivacy` 看到的是已打码文本 | 隐私闸门提到脱敏之前，与 `cmdDeclare` 一致 |
| 6 | 面板说「按优先级排列」，核心条目却不在最前 | `rankItem` 的注释写「核心优先」，实现只按权重排 | 比较器加 `core` 优先；注入块与面板终于用的是同一条规则 |

## 四个「测试自己写错」

| 用例 | 错在哪 | 改成 |
|---|---|---|
| `edit` 应该拒绝手机号 | 手机号属于「打码后允许」，只有证件号/银行卡/密码/精确住址才拦截 | 拦截用身份证；另加一条断言手机号被打码写入 |
| 面板应该带配置告警 | 先跑 `status` 会把坏配置修好，再查 `panel` 自然没有告警 | 先查 `panel`；要验 `status` 的告警就再弄坏一次 |
| 快照上限应该 ≤20 | 用不存在的 id `forget` 直接从 `die` 返回，根本没产生快照 | 每条先建再删，真删 25 次 |
| 预算该先裁背景 | 三条红线的 `fact` 只差一个尾字，被相似度合并成 1 条，测的不是预算 | 用彼此不相似的三句话 |

## 顺带修的一处语义

`set` 之后不重建时，`inject.maxChars` / `inject.topK` 这类**只在 build 时生效**的键不会立刻反映到 `inject.md`。
回执本来就写了「下次生成画像时生效，想立刻应用加 `--rebuild`」，但 `tests/audit-3.mjs` 第一次跑就是被它绊住的——说明这句话不够醒目。
现在这层依赖写进了测试注释，也在本节留档：**改预算类配置后要 build 才看得到效果**（面板的「保存并重建」会自动做）。

## 第七个 bug（自己造的）：自检套件会把真实画像改坏

跑完 `tests/e2e.mjs` 后随手看了一眼真实环境，发现 `status` 里的预算是 `maxChars=1600, topK=8` ——
而真实配置本来是 `0/0`（不设上限）。往回查：`tests/e2e.mjs` 的 B 段打的是**运行中的宿主**，
里面有两条用例真的发了 `set inject.maxChars 1600` 和 `settings inject.topK 8`，
它们落在真实 `config.json` 上，测试结束也不还原。

后果很隐蔽：自检报告 42/42 全绿，但用户的注入块从此按 1600 字截断，而「条数不设上限」这个刚做的决定被静默推翻。
这正是这一轮要找的那类错——**假的成功**。

修法：B 段开始前把 `config.json` / `declarations.jsonl` / `pending.jsonl` 三个文件读进内存，
在 `process.on('exit')` 里无条件还原（含异常与中断），再跑一次 `build --all-scopes` 让画像跟着回到原样；
开跑时先打印一行「B 段会临时改动真实画像，结束时自动还原」。

真实数据已核对：`declarations.jsonl` 仍是 18 条、里面没有任何 `e2e-` 或「自检」残留，
`inject.md` 从 986 字符回到 2236 字符（不截断），`status` 显示 `maxChars=0, topK=0`。

## 顺带脱敏

`_sessions.mjs` 与 `scripts/build-video.ps1` 里写着带用户名的绝对路径（工作区桶名、ffmpeg 安装路径）。
前者改成「省略参数时自动挑会话最多的那个桶」，后者改成 `$env:FFMPEG` 或 PATH 查找。
仓库里现在搜不到用户名与本地路径。


## 验证

```
node --check 12 个文件        0
tests/selftest.mjs                全部通过
tests/audit-1.mjs                   33 / 33
tests/audit-2.mjs                  34 / 34
tests/audit-3.mjs                  51 / 51
tests/render.mjs                  全部通过
tests/e2e.mjs（含真实 HTTP）        42 / 42
scripts/verify-install.mjs   13 / 13
```

真实数据未受影响：画像仍是 17 条，`profile validate` 0 条不合格。

## 生效方式

- `bin/profile.mjs`：立即生效（每次请求现起子进程）。
- `index.js` / `mcp/server.mjs`：重启 dsh 后生效（本轮没有改 `index.js` 的行为，`mcp/server.mjs` 的未知工具分支要重启宿主才用得上）。
- `client.js`：刷新设置页即可（本轮未改）。

## 仍未做

1. 接受候选时的去重只比字面，同义不同措辞仍会并存（要么人工 `merge`，要么等 build 的相似度合并）。
2. `pushSection` 在预算极紧时会留下一个只有标题、没有条目的段头（纯观感，不影响内容）。
3. 相关性判定仍是字符二元组，跨语言/同义词不认。
