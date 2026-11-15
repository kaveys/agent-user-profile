# v4：把设置页做成真正的控制台

用户原话：「更加自定义，要有一个大型的、好用的插件的样子」。

v2/v3 的设置页是一张只读表：能看，不能动；想改一条得回终端敲命令。v4 把它换成一个七页签的应用，
所有日常操作都在页面上完成，配置项逐个带路径、改完即写盘并重建画像。

## 一、面板：七个页签

| 页签 | 内容 | 写操作 |
| --- | --- | --- |
| 概览 | 8 张 KPI、画像过期警示条、维度分布、权重分布、近 14 天活跃柱、常用工具构成、运行状态 | — |
| 条目 | 搜索（内容 / key / 维度）、维度过滤、排序（权重 / 时间 / 维度）、多选批量操作、行内编辑 | 设核心 / 取消核心 / 删除 / 编辑现有条目 |
| 待审 | 模型提炼的低置信候选 | 接受 / 丢弃 / 全接受 / 全丢弃 |
| 冲突与历史 | 冲突双方（A/B）+ 判定文案；历史留档标明是被覆盖还是被判为同义合并 | — |
| 维度 | 每维条目 / 声明 / 行为计数 | 新增维度、删除维度 |
| 设置 | 4 组 17 个字段（注入 / 冲突与去重 / 智能提取 / 采集与隐私），每字段下方标配置路径 | 保存并重建（只提交改过的项） |
| 数据 | 9 条存储路径 | 导出、立即重建、批量导入（贴 JSON）、重置全部数据 |

设计上的四条硬约束：

1. **只 `require('react')`**，不引任何宿主客户端包、不写 JSX、不引入构建链 —— 手写 bundle 由宿主的 `__ModuleLoader__` 直接装载。
2. **着色只用 `--dsw-alias-*` 主题变量**，不写死颜色，亮/暗主题跟随宿主。
3. **页面和注入块共用同一套排序**（`flatten()`），所以表格第一行永远就是注入时排第一的那条。
4. **失败要说人话**：写操作失败时把 CLI 的原始输出贴回页面（`notice`），不吞成「操作失败」。

## 二、新增的写通道

### 面板数据：`GET /user-profile/panel.json`

payload 从 v3 的 8 个键扩到 18 个：

```
ok home cli dimensions profile live drift items conflicts pending
paths settings stats activity toolMix hours history
```

- `activity` 最近 14 天 `{date,turns,steps}`；`toolMix` 前 6 名 `{tool,count,pct}`；`hours` 前 3 活跃小时；
  `conflictStats{merged,resolved,frozen,open}`；`historyItems` 各维 `history` 汇总（前 30 条，按 `lastSeen` 降序）。
- `settings` 是全量可编辑配置（含 `redaction.patternCount` 这类只读派生值），面板据此渲染表单。
- `drift` 做一致性自检：`{stale, built, live}` —— 声明数变了却没 build 时 `stale=true`，概览页顶部出现警示条。
  这条是给 v3.1 那个「画像过期却不吭声」的坑补的封条。

### 面板动作：`POST /user-profile/action`

| action | 参数 | 落到 CLI |
| --- | --- | --- |
| `declare` | `{dim, fact, key?, core?, pending?, scope?}` | `declare …` |
| `forget` | `{id}` 或 `{id:'all'}` / `{key}` / `{dim}` | `forget …` |
| `edit` | `{id, fact?, dim?, key?, confidence?, core?}` | `edit …` |
| `merge` | `{keep, drop}` | `merge --keep … --drop …` |
| `review` | `{accept, id}` | `review --accept/--reject …` |
| `settings` | `{entries:[{path,value}]}` | 逐条 `set`，全部成功后 `build --all-scopes` |
| `importText` | `{items:[…]}` | 写临时文件 → `import --file` → 删临时文件 |
| `export` | `{out?}` | `export --out …`（缺省 `~/.dsh/user-profile/export/<ts>`） |
| `reset` | `{confirm:true}` | `reset --yes` |
| `dims` | `{dimsAction:'add'\|'remove', id, label?}` | `dims add/remove …` |
| `build` | `{}` | `build --all-scopes` |

两条路由都先过宿主的 `connection.requestRejection` 鉴权闸门，异常时 fail-closed 返 500；
动作体上限 64KB，非法 JSON / 未知动作返 400。任何写动作成功后立刻让 2 秒的 panel 缓存失效，页面刷新即见新状态。

### 为什么要有 `merge`

自动去重只认字面相似度（二元组 Dice ≥ `build.similarityThreshold`，默认 0.45）。
「每个插件只做一件事」和「不同插件职责分离」实测相似度 0.462 —— 刚好过线；
但措辞差得多的同义句不会被自动合并，硬提高阈值又会误伤。所以把**判断权交回人**：页面上选中两条，
`merge --keep A --drop B`，B 的内容进 A 的 `mergedFrom`，changelog 记一笔 `kind:'merge'`。

## 三、渲染烟测 `_render.mjs`

面板改版最大的风险不是逻辑，而是「点了页签白屏」。为此写了一个不依赖宿主、不依赖浏览器的烟测：
自带极简 hooks 运行时（`useState/useCallback/useEffect/createElement`），把真实的 `ProfileSection`
渲染成树，然后**逐个页签点击**并断言关键文案（KPI 标题、表头、表单字段名、路径行数）。

三个坑（都已修，改这个文件时别踩回去）：

1. 每个函数组件必须有自己的 hook store（`stores = new Map()`，进出 `renderComponent` 时切换 `hookStore/hookCursor`），
   否则父子抢同一个 slot，断言会假失败。
2. setter 必须绑定自己那份 store（`const store = hookStore`，setter 里写 `store[index]`），
   否则 effect 里的异步回调写到别的组件上，报 `Cannot read properties of undefined (reading 'data')`。
3. `createElement` 必须把子节点塞进 `props.children`，否则 `<Section>{…}</Section>` 这类解构 children 的组件渲染成空壳。

## 四、回归结果

| 项 | 结果 |
| --- | --- |
| `node --check` × 3（index.js / client.js / bin/profile.mjs） | 全 0 |
| `_render.mjs` | 20 项全通过 |
| `_selftest.mjs` | 全部通过（含并发写、陈旧锁、去重、drift、提炼器复用 key） |
| `scripts/verify-install.mjs` | 12 项全通过（含「client bundle 未 require 宿主客户端包」「着色只用主题变量」） |
| 真机视觉 | 设置页七个页签逐个点开截图核对：概览 KPI/分布/活跃柱、条目表（10/10 条、权重条、三个操作按钮）、冲突与历史（1 条判定 + 1 条留档）、维度表（6 维 + 新增表单）、设置（4 组表单 + 保存并重建）、数据（9 条路径 + 导出/重建/导入/重置） |

## 五、生效条件（重要）

| 改了什么 | 怎么生效 |
| --- | --- |
| `client.js`（面板界面） | dsh-client-hmr 热重载，刷新设置页即可 |
| `bin/profile.mjs`（CLI / payload） | host 每次调用都起新进程，**立即生效** |
| `index.js`（路由、动作表） | **必须重启 dsh**；未重启时 `POST /user-profile/action` 对新增动作返回 `400 未知动作` |

## 六、仍未做的

- 面板没有把 `historyItems` 做成可点击回溯（现在只是列表）。
- `merge` 只能手动两两合并，没有「相似度候选」自动推荐。
- 设置页没有 `suppressPatterns` 编辑器（仍是改 `config.json`）。
