# v3.1 修复记录：丢记录、同义重复、画像过期不可见

用户报告「继续修正，有BUG」。逐项定位到三个真问题，全部修完并有回归用例覆盖。

## 一、丢记录（最严重）

### 现象
`declarations.jsonl` 只有 5 条，但 `profile.json` 记着 `stats.declarations = 8`。三条声明只活在画像里，磁盘上已经没了：

| id | 维度 | 内容 |
| --- | --- | --- |
| `dcl_mwhotdw9zj6i` | preferences | 用户要求每个插件只做一件事，功能不许混在一起 |
| `dcl_mwhoipsgjb7r` | expertise | 用户熟悉 DSH 插件机制，能主导用户画像插件的功能设计 |
| `dcl_mwhotdup9wv1` | constraints | 用户要求任务清单同步与用户画像功能严格独立、互不耦合 |

### 成因
`declare` 是纯追加（`appendFileSync`，O_APPEND 安全），但 `forget` / `edit` / `review --accept` 都是「读全量 → 改几条 → 整表写回」。两个进程撞在一起时，后写的一方会把前一方刚追加的记录整片抹掉。另外 `writeJson` / `writeJsonl` 原本直接 `writeFileSync` 覆盖，进程被杀就留下半截文件。

### 修法
1. `writeFileAtomic(file, text)`：同目录写 `.tmp-<pid>-<ts>` 再 `renameSync` 替换 —— 读者永远看不到半截文件。
2. `withLock(fn)`：`openSync(p('.lock'), 'wx')` 抢锁，`finally` 删锁；`EEXIST` 时若锁文件的时间戳超过 60s 视为陈旧并清理（进程被 kill 不会永久锁死），否则 50ms 后重试，最多 10s，超时给出可读错误。
3. `MUTATING` 集合（`declare` `observe` `build` `review` `forget` `edit` `import` `dims` `set` `reset`）全部走 `withLock` —— 追加型也加锁，否则它可能正好插在别人「读」和「写回」之间，照样被抹掉。
4. 已丢失的 3 条按 `profile.json` 里的 `history`/`items` 补回 `declarations.jsonl`（脚本 `20261115-1730-画像插件排障/restore-missing.mjs`，带 `--dry`），补回的记录带 `restoredFrom: "profile.json"` 与 `restoredAt`，来源可追溯。

## 二、同义条目并存（画像越用越肿）

### 现象
画像里同时存在：

- `[偏好 0.9] 用户要求每个插件只做一件事，功能不许混在一起`
- `[偏好 0.45] 用户要求不同插件职责分离，功能不要混在一起`

同一件事被模型换了个 key 重述一次，就多出一条。

### 修法（两层）
1. **治标：同维度近似去重**。`build` 时算字符二元组 Dice 系数（去标点空白后），`≥ similarityThreshold` 判为同一件事：保留权重高的那条，`evidence` 合并，`firstSeen` 取更早，另一条进 `section.history`（`mergedAs: 'duplicate'`），并记一条 `conflicts` 项 `status: 'merged'`。默认阈值 **0.45** —— 实测这对同义改写是 0.462，而不相关的两条只有 0.314，0.45 正好切在中间。
2. **治本：让提炼器复用已有 key**。`extractTurn` 把画像里已有的条目以 `- <dim>/<key>：<一句话>` 列表塞进 prompt，并加规则「同一件事必须复用已有 key，只更新 fact 文字，不要新造 key」。

## 三、画像过期对用户不可见

画像里记 8 条、磁盘上 9 条，面板照样显示旧内容，用户没法知道该 rebuild。

- `panel` 新增 `drift: { stale, built, live }`；当 `stale === true` 时面板顶部出现一行警告：「画像过期：画像里记的是 N 条声明，磁盘上已有 M 条。」
- `status` 新增 `stale` 字段，为真时多打印一行「画像已过期 → 运行 build 刷新」。

## 四、顺带修掉

- `profile.md` 把 `merged` 状态的冲突也列进「待确认冲突」并写「未决，注入时不选边」——这是错的，合并时是**选了**的。现在 `merged` 单独成节，说明「判为同一件事，保留权重更高的那条」。
- 面板冲突列表把 `merged` 显示为「判为同义，已合并（保留权重更高的那条）」。

## 回归

`tests/selftest.mjs` 新增第 17、18 组，共 9 条断言：

```
PASS  同义条目被自动合并（相似度 0.46 > 阈值 0.45）
PASS  合并后只留权重更高的一条
PASS  合并后画像不自相矛盾
PASS  写了新数据但没 build → 面板标出画像过期
PASS  status 也标出过期
PASS  提炼器拿到了「已有画像条目」以便复用 key
PASS  6 个并发写 + 1 个 build 后一条不丢
PASS  陈旧锁被自动清理
```

`node --check`（index.js / client.js / bin/profile.mjs / tests/selftest.mjs）全过；`verify-install.mjs` 12 项全绿；`register.mjs` 已把安装副本同步到与工作区逐字节一致。

## 当前真实数据状态

- 画像 **v14 · ready · 10 条**（原 11 条，同义偏好合并掉 1 条）
- 声明 **8 条**（补回 3 条后与画像计数一致），`drift.stale = false`
- 注入正文 **683 字符**
- 待审候选 0 条
