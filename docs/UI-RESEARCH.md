# DSH 插件设置界面（client 半边）调研笔记

> 目标：给 host 端 cordis 插件 `dsh-user-profile` 增加一个设置页面板（用户画像条目列表，按权重降序，可刷新 / 删除 / 确认待审），数据由 host 以 JSON 暴露。
> 调研对象：本机安装版 DSH（Desktop / Electron），非源码树。
> 结论先行：**能，而且要写的代码比预想的少** —— 但要先修好模块解析（第 0 节），并且 client 代码是**手写 bundle**，本机没有构建工具链。

路径前缀约定（下文一律用这两个缩写，均可在 shell 里直接展开）：

- `<CHECKOUT>` = `<home>\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh`
- `<PLUGIN>` = `<home>\Desktop\DSH默认工作区\20261114-2354-用户画像插件`（本次工作区；镜像到 `~/.dsh/plugins/dsh-user-profile`）
- `~` = `<home>`

---

## 0. 先决问题：裸名 `dsh-user-profile` 现在根本解析不到（阻塞项）

这一点优先于所有 UI 工作，否则加什么 client 代码都不会被加载。

实测：

```
$ cd ~/.dsh/profiles/desktop && node -e "import.meta.resolve('dsh-user-profile')"
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dsh-user-profile'
$ cd ~/.dsh/profiles/desktop && node -e "import.meta.resolve('dsh-better-sidebar')"
file:///<home>/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/index.js   ← 正常
```

原因：本机插件是靠 **profile 目录的 node_modules 里放 symlink** 挂进去的，而 `scripts/register.mjs` 只写了 `~/.dsh/cordis.patch.yml` 的 insert 块，没建链接：

```
$ ls -l ~/.dsh/profiles/desktop/node_modules | grep dsh-
dsh-creative-studio -> <home>/.dsh/plugins/dsh-creative-studio
dsh-mcp-deferred     -> <home>/.dsh/plugins/dsh-mcp-deferred
dsh-todo-sync        -> <home>/.dsh/plugins/dsh-todo-sync
```

而 `~/.dsh/cordis.patch.yml` 末尾确实有：

```yaml
    - insert:
        - id: user-profile
          name: 'dsh-user-profile'
```

`name:` 是裸 specifier，交给 Loader 用 profile 的 `node_modules` 解析（`<CHECKOUT>/node_modules/@deepseek-ai/dsh-app-boot` 注释 499-503：解析锚点是「安装目录」+「profile 目录」两处）。缺链接 ⇒ ERR_MODULE_NOT_FOUND。

旁证：`~/.dsh/user-profile/observations/` 为空 —— host 半边从一个更早的时间点起就没在跑，本会话里所有 tool 调用都没落 observation。

**修法（一行，Windows 上需要管理员或开发者模式）**：

```bash
ln -s <home>/.dsh/plugins/dsh-user-profile \
      <home>/.dsh/profiles/desktop/node_modules/dsh-user-profile
# 或 mklink /D
```

修完要**重启 dsh**（Electron 整个 app），因为 host 端插件的加载发生在 profile boot。

---

## 1. client 侧插件怎么注册（package.json / exports / patch）

### 1.1 约定：`dsh.client.platform === "web"` + `exports["./client"]`

`<CHECKOUT>/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`

```js
// :62
function parseDshClient(pkgName, value) {
	...
	// :66
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	// :67-69  dsh.client.inject: string[] / dsh.client.external: string[] / dsh.client.immediately: boolean
```

```js
// :720
	resolveMeta(loaderName, baseUrl) {
		...
		// :732
		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		// :733-736  ← 关键闸门
		if (decl === void 0 || decl.platform !== "web") {
			this.pkgMeta.set(sourceKey, null);
			return null;
		}
		// :737
		const clientRel = clientExportOf(packageName, pkg.exports);
		// :738
		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
		...
		// :742
		clientPath: join(dirname(pkgPath), clientRel),
```

入口解析（产物路径**不是**固定的 `lib/client.js`，完全由 exports 决定）：

```js
// :172
function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return void 0;
	const client = exportsField["./client"];          // :174
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;    // :176  ← 字符串即可
	if (typeof client === "object" && client !== null) {
		const fallback = client.default;                // :178
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}
```

所以本工作区 `package.json` 现有的写法**是对的**（`<PLUGIN>/package.json`）：

```json
"exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
```

`./client` 指向根级 `client.js` 完全合法（解析 = `join(pkg目录, clientRel)`）。

已装第三方包的完整样板（`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/package.json:40-54`）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-slots",
               "@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-sidebar-right",
               "@deepseek-ai/dsh-client-modules"],
    "platform": "web"
  },
  "manifestVersion": 1
}
```

`dsh.client.inject` 的语义 = **先把这些包的 client bundle 载入**（构成 module graph 的边），不是 host 端的 service 注入。

### 1.2 致命细节：声明了 `dsh.client` 但文件不存在 ⇒ 整个 client 组合启动失败

```js
// :129
const CLIENT_BUNDLE_BUILD_INSTRUCTION = "run `pnpm run build` before launch";
// :131-143 MissingClientBundleError：`client-modules: client bundle not found; ...`
// :145     ClientPackageCompositionError（AggregateError，构造 ClientModuleSystem 时抛出）
```

也就是说：**package.json 加 `dsh.client` 和 `client.js` 落地必须同一次完成**，中间态会让页面起不来（这是最容易踩的坑）。

### 1.3 cordis.patch.yml 里**没有** client 半区

`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/cordis.patch.yml:1-12` 的注释把机制说死了：

```
# This file is the `dsh.bundle.patch` layer of the published npm package: when
# the plugin is installed through the official CLI —
#   dsh plugin --profile <name> add dsh-better-sidebar@<version>
# — the command reconciles `dsh.profile.bundles` against installed packages
# and, seeing this declaration, appends `dsh-better-sidebar` to the bundle
# stack. The profile boot then merges THIS patch (a single `insert` of the
# plugin row) exactly like the manual cordis.patch.yml mount line used
# before.
```

它的 patch 正文只有 `insert` 一行插件行，**完全没有 client 段**。客户端半边靠 `package.json` 的 `dsh.client` **自动发现**（`dsh-client-modules` 扫 `ctx.loader.entries()`）。⇒ **我们不需要改任何 cordis.patch.yml 来上 UI。**

### 1.4 bundle 的运行期形状（手写时的模板）

真实产物（`<CHECKOUT>/node_modules/@deepseek-ai/dsh-client-ui-settings-shell/lib/client.js:1-9`）：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings-shell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

约束（`<CHECKOUT>/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js`）：

- `id` 必须等于**包名**，否则报 `client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`（:758, :874）。
- 同一个 id 重复执行报 `duplicate factory registration for "<id>" (bundle executed twice without invalidate?)`（:708）。
- `factory` **只登记不执行**，materialize 时才跑 body：`exports: registered.factory(this.makeRequire(ownerId, edges))`（:817）。CSS 注入放在 factory 体内是正常的。
- 可 `require` 的只有 **11 个 seed 模块 + 图里已加载的其他包**；否则 `client-modules: require("${spec}") missed the module table …`（:840）。

---

## 2. 设置页怎么插一个面板（准确 API）

### 2.1 准确名字

**没有** `ctx.settings.page(...)`，**没有** `ctx.webUi.settingsSection(...)`，**没有** `ctx.client.settings.register(...)`，也**没有** `@deepseek-ai/dsh-web-ui` 这个包（`ls -d dsh-web-ui` → No such file or directory）。

设置页就是一个 **slot**：`settings.section`，走 `ctx.slots`。

client 侧存在的服务只有 8 个（`<CHECKOUT>/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 内嵌的 API 目录，`key:` 逐条）：`layout`(1127)、`locale`(1170)、`sessions`(1266)、`slots`(1362)、`theme`(1399)、`timer`(1452)、`uiWorkspace`(1489)、`workspaces`(1615)。

### 2.2 契约（同一份目录，权威）

`<CHECKOUT>/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:5340` 起：

```
key: "settings.section",
kind: "list", scope: "root",
summary: "One settings page per list entry"
registerOptions:
  id     : required, string
  order  : optional, number（默认 0）
  label  : optional, string | (() => string)  — "A thunk is re-read on every projection"
ownerProps: export interface SettingsSectionOwnerProps { close: () => void }   ← 只给 close
declaredBy: "an entry in 'sidebar.settings' (client-ui-settings-general), so it exists while that entry is mounted"
occupants : agent-preset / account / general / models / plugins
source    : "packages/client/ui-settings/src/client/contract/slots.ts:57"
```

同目录里可直接抄的 `example`：

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

### 2.3 生命周期：`slots.inject` 是必须的外壳，disposer 自动回收

`dsh-cordis-client-runner/lib/client.js:1362` 起的 `slots` 服务条目：

```
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
  "Install an effect for each declaration lifetime of a slot. The callback runs synchronously
   when the declaration already exists; otherwise it runs inside the declaring register() call
   after the declaration is committed. …  The controller belongs to the caller's fiber, so
   plugin unload cancels a pending wait and removes any active contribution."
```

`register(entry, Component)` 返回 disposer；`list` 类按 `priority` 再 `order` 排序，同 priority 同 id 重复会抛 `list slot "..." already has an entry with id "..."`。**所以"等 slot 被声明后再注册"必须用 `inject` 包一层，别直接 register**（设置页外壳可能还没挂载）。

### 2.4 真实注册（官方 settings 自己怎么写）

`<CHECKOUT>/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`

声明（:1239-1274，节选到 :1267）：

```js
const disposeSlot = ctx.slots.register({
	name: "sidebar.settings",
	locale: NS,
	store: shellStore,
	children: {
		"settings.launcher": { kind: "single", scope: "root" },
		...
		"settings.section": { kind: "list", scope: "root" },   // :1264-1267
		"settings.onboarding": { kind: "list", scope: "root" }
	},
	inject: shellInjected
}, SettingsRoot);
```

"general" 自己作为 section 的注册（:1299-1308）：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
	name: "settings.section",
	id: "general",
	order: 0,
	label: () => t("general.nav"),
	locale: NS,
	children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```

渲染点与 props（:337）：

```js
children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })
```

导航行只读 `id/order/label`，**不读 icon**（:1151-1166）：

```js
rows = ctx.slots.entries("settings.section").map((e) => ({ ... }));   // id / order / label
const offLedger = ctx.slots.subscribe("settings.section", listener);  // :1161
```

`label` 可以是 thunk，`resolveSlotLabel` 直接调用它（`function $I(e){return typeof e=="function"?e():e}`），**不需要 locale 也能用**。

---

## 3. host → 页面 的 JSON 通道

### 3.1 host 侧：`ctx.webServer.register({ kind, path, handler })`

服务名 `webServer`（包 `@deepseek-ai/dsh-host-webserver`）。`register` 返回 disposer，重复注册抛 `webserver: duplicate ${route.kind} route "${route.path}"`。route 形如 `{ kind: "exact" | "prefix", path, handler(req, res) }`。

真实样板（`<CHECKOUT>/node_modules/@deepseek-ai/dsh-host-open-in-app/lib/index.js`）：

```js
// :1160-1164
const inject = ["webServer", "connection", "subprocess"];

// :1263-1270  —— 鉴权闸门
const rejected = (req, res) => {
	const rejection = connectionOf(ctx).requestRejection(req);
	if (rejection === void 0) return false;
	res.statusCode = rejection;
	res.end();
	return true;
};

// :1271-1282  —— 完整 JSON 路由
ctx.effect(() => ctx.webServer.register({
	kind: "exact",
	path: OPEN_IN_APP_APPS_PATH,           // "/open-in-app/apps"（:1126）
	handler: async (req, res) => {
		if (rejected(req, res)) return;
		if (req.method !== "GET") { sendMethodNotAllowed(res, "GET"); return; }
		sendJson(res, 200, { apps: [...(await availability()).keys()] });
	}
}), `open-in-app: GET ${OPEN_IN_APP_APPS_PATH}`);
```

`sendJson` 的实现（同文件 1172-1186）：

```js
res.statusCode = status;
res.setHeader("content-type", "application/json; charset=utf-8");
res.setHeader("cache-control", "no-store");
res.end(JSON.stringify(payload));
```

### 3.2 鉴权 / base URL 约定

同文件 :1141-1156 的注释是官方的说法：

```
Every route asks the composition's `connection` service for a rejection first
(`requestRejection`): its Host/Origin fence defeats DNS rebinding and cross-site calls,
and its browser authentication (the login-token cookie) gates every caller.
```

实测验证：不带 cookie `curl http://127.0.0.1:52442/` → **401**（68 字节）。⇒ 页面里 `fetch` 必须走**同源**，cookie 才会自动带上；host 的插件路由**不发任何 `Access-Control-Allow-*`**，跨源 fetch 会被浏览器直接拦掉。

client 侧两种真实写法：

```js
// A. 最简单：去掉前导斜杠，交给页面 base 解析
// <CHECKOUT>/node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js:12
const OPEN_IN_APP_APPS_ROUTE = "/open-in-app/apps".slice(1);
// :146
fetch(OPEN_IN_APP_APPS_ROUTE, { headers: { accept: "application/json" } })
```

```js
// B. 抗反代目录前缀：用 document.baseURI 做 base
// ~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js:1182-1186
function hostHttpBase() {
	const base = typeof document !== "undefined" ? document.baseURI : void 0;
	if (typeof base === "string" && base !== "") return base;
	return hostTransportBase();
}
// :1231
function hostRouteUrl(path, baseUrl = hostHttpBase()) { /* new URL(path.replace(/^\/+/,""), directoryBase(baseUrl)) */ }
```

注释（同文件 :1202 起）：桌面 shell 页面是 `dsh-app://app/`，Electron 的 `protocol.handle` 把非静态 `dsh-app://app/*` 转发到 Host（同源）；`document.baseURI` 自带你需要的目录前缀，一条规则覆盖「直连 127.0.0.1」和「反代子路径」两种部署。

> 另有 `host.call(method, args)` RPC（`dsh-cordis-client-runner/lib/client.js:7049`：`host.call(method: string, args?: JsonValue): Promise<JsonValue>`），但那是 runner 体系里「动态 client 插件」的通道（配套 `harness.handle`），**不是普通插件的通用数据通道**，本机是否暴露对应能力未验证 —— 不要依赖它。

---

## 4. client 侧可用的 UI 组件库

### 4.1 能 require 的模块（就这些）

`<CHECKOUT>/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 里的平台模块表（压缩成单行，无行号，按字符偏移；`function OZ(){ return {…} }`）：

```
react · react/jsx-runtime · react-dom · react-dom/client · @deepseek-ai/cordis · zod
@tanstack/react-virtual · @deepseek-ai/dsh-client-store · @deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives · @deepseek-ai/dsh-client-ui-dockkit
```

**没有 Tailwind 运行时，没有 `@deepseek-ai/dsh-web-ui`**。样式只有两条路：包内注入 `<style>`（见 :645-652 的 `data-plugin-css` 模式），或 inline style / 直接吃 CSS 变量。

### 4.2 `@deepseek-ai/dsh-client-ui-primitives` 有什么

从 shell bundle 的 `const TU = Object.freeze(Object.defineProperty({ __proto__: null, …` 导出表里提取（节选，都是真实导出名）：

- 控件：`Button`、`Input`、`Switch`、`Checkbox`、`SegmentedControl`、`SegmentedTabs` …
- 容器/反馈：`Tag`、`Pill`、`Tooltip`、`Modal`、`Menu`、`MenuItemButton`、`MenuSurface`、`DisclosureRow`、`HoverCard`、`StateDot`、`Toast`、`TextShimmer`
- 内容展示：`JsonBlock`、`JsonTree`、`CodeBlock`、`MarkdownText`、`PathLabel`
- 表单：`SettingsForm`、`SettingsFormModel`、`SettingsValueField`、`SettingsSecretField`、`settingsTextField`、`settingsNumberField`
- 图标：`IconTrashOutlineRegular`、`IconRefreshOutlineRegular`、`IconUserOutlineRegular`、`IconListPenOutlineRegular`、`IconSettingsOutlineRegular`、`IconPlusOutlineRegular`、`IconChevronDownOutlineRegular` …（每个还有 `…Medium` 变体）
- **没有 `Table` / `DataTable`** —— 表格自己用 `<table>` 或 flex 行写。

真实 import 与用法：

```js
// <CHECKOUT>/node_modules/@deepseek-ai/dsh-client-ui-settings-shell/lib/client.js:8-9
let react_jsx_runtime = require("react/jsx-runtime");
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
// 用到 _deepseek_ai_dsh_client_ui_primitives.SettingsForm / .SettingsValueField
```

```js
// <CHECKOUT>/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:760-766
jsx(primitives.Button, { variant: "outline", size: "sm", disabled: state.opening, onClick: () => controller.open(), children: t("openDocument") })
jsx(IconCloseOutlineRegular, { size: 14 })
```

`resolveSlotLabel` 不在 primitives，在 `@deepseek-ai/dsh-client-ui-slots`（本工作区 `client.js` 没用它，`label` 直接给字符串/thunk 即可）。

---

## 5. 构建与生效

### 5.1 是预编译 bundle，不是运行时编译

- 构建器是 **tsdown**（`dsh-client-modules/lib/index.js:165`：`const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=…/`，注释「Source-map trailer emitted by tsdown at the end of every client bundle」）。
- CSS 以 `//#region \0dsh-css:…` 内联进 bundle（`dsh-client-ui-settings-general/lib/client.js:642-651`）。
- **本机没有构建工具链**：`<CHECKOUT>/node_modules/.bin` 为空，`node_modules/tsdown`、`node_modules/rolldown` 都不存在，`<CHECKOUT>` 下也没有 `docs/`。

⇒ 本地插件只能**手写**符合 1.4 形状的 `client.js`（本工作区的 `client.js` 已经是这个路子，303 行）。不需要任何构建命令，也不要装依赖。

### 5.2 生效链路

- bundle 由 `dsh-client-modules` 以 `kind:"prefix"`, `path:"/plugins"` 的路由伺服（`index.js:202`、:564-570），首页通过 `webserver/index-inject` tap 注入 boot 表（:572-574）。
- module graph 只在 **ClientModuleSystem 构造** 和 `ctx.on("internal/plugin")`（插件条目变化）时重组。
- `dsh-client-hmr`：host 半边 inject `["clientModules","webServer"]`，`Config = z.object({ pollIntervalMs: z.number().step(1).min(1).default(500) })`，500ms stat 轮询图里每个 row 的 `clientPath`（mtime/ctime/size）→ `ctx.clientModules.rebuilt(id)` + SSE `/plugins/events` → 浏览器 `entries.reload(frame.id, frame.rev)`。

**因此：**

| 改动 | 生效方式 |
|---|---|
| 首次新增 `dsh.client` 声明 / `client.js` 文件 | **重启 dsh**（Electron 整个 app） |
| 之后改 `client.js`（文件已入图） | 等 ~0.5 秒，页面自动换载；必要时刷新页面 |
| 改 `index.js`（host 半边）、`package.json` | **重启 dsh** |
| 只改 JSON 数据（`~/.dsh/user-profile/profile.json`） | 面板刷新按钮即可（host 侧 2s 缓存） |

---

## 6. 不写 React 的替代方案（以及它做不到什么）

**能做到**：host 侧注册一条返回 HTML 的路由，用户自己在浏览器打开。API 与 JSON 路由同一个：

```js
ctx.effect(() => ctx.webServer.register({
  kind: "exact",
  path: "/user-profile/ui",
  handler: (req, res) => {
    if (rejected(req, res)) return;                       // connection.requestRejection
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(HTML);
  }
}), "user-profile: html ui");
```

打开 `http://127.0.0.1:52442/user-profile/ui`（端口取自当前 URL；cookie 已在，通过鉴权）。静态资源可用 `kind: "prefix"` 挂一整棵目录（参照 `dsh-host-open-in-app` 的 `OPEN_IN_APP_ICON_PREFIX_PATH` 路由，:1283-1290）。

**做不到**：**不会出现在设置页**。设置页是一个 React modal，分区只能由 `renderSlot("settings.section", …)` 渲染 slot 条目；没有「注册 HTML 页面到设置页」的 API（`ls`/`grep` 未找到任何 `settings.page(html)` 类入口，也没有 `webPages` 服务）。

⇒ 只要需求是"出现在设置页"，**最小 React 面就是必须的**：一个函数组件 + `React.createElement`（本工作区 `client.js` 已经在用 `h = React.createElement`，不需要 JSX、不需要构建）。成本比 HTML 方案只多一点，收益是天然出现在设置页、自动跟随主题/语言。

---

## 7. 最小可行实现清单

### 7.1 已具备（`<PLUGIN>` 现状，无需重写）

| 文件 | 现状 | 判定 |
|---|---|---|
| `package.json` | `exports["./client"] = "./client.js"`、`dsh.client.platform = "web"`、`dsh.bundle.patch` | ✅ 契约正确 |
| `cordis.patch.yml` | 只有 insert 行 | ✅ 不用改（client 靠 dsh.client 自动发现） |
| `client.js`（303 行） | `__ModuleLoader__.load({ id:'dsh-user-profile', factory })`；`require('react')`；`ENDPOINT = '/user-profile/panel.json'`；`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'user-profile', order:55, label: () => '用户画像' }, ProfileSection))`；`exports.inject = ['slots']`；含 loading/error/表格/ItemRow | ✅ 结构完全符合 1.4 与 2.2/2.3 |
| `index.js`（386 行） | `:175 PANEL_ROUTE='/user-profile/panel.json'`、`:198 panelHandler`（405/200/500 + `no-store`）、`:372-385 ctx.inject(['webServer'], web => web.effect(() => web.webServer.register({kind:'exact', path:PANEL_ROUTE, handler:panelHandler}), …))` | ✅ 路由注册方式正确 |
| `bin/profile.mjs` | `COMMANDS = { init, declare, observe, build, show, status, panel, review, forget, set, reset, export }` | ✅ 数据源齐 |

### 7.2 需要补的（按优先级）

| # | 位置 | 改动 | 行数 |
|---|---|---|---|
| 1 | `~/.dsh/profiles/desktop/node_modules/` | 建 symlink `dsh-user-profile → ~/.dsh/plugins/dsh-user-profile` | 1 条命令 |
| 2 | `index.js` panelHandler | 加 `connection.requestRejection(req)` 闸门（现在任何本机进程都能读画像）；`connection` 作可选服务（`ctx.inject(['connection'], …)` 或 `Reflect.get(ctx,'connection')` + 判空） | ~8 行 |
| 3 | `index.js` | 加 **POST** 路由 `/user-profile/panel/action`：body `{op:'forget'|'review', id}` → `execFile(process.execPath, [CLI_PATH,'forget',id])` / `['review','--approve',id]`；成功后清 `panelCache` | ~35 行 |
| 4 | `client.js` | 删除/确认按钮 `fetch(ENDPOINT_ACTION, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({op,id})})` 然后 `load()` | ~20 行 |
| 5 | `client.js` | 可选美化：`require('@deepseek-ai/dsh-client-ui-primitives')`，用 `Button`（`variant:'outline' size:'sm'`）、`Tag`、`IconTrashOutlineRegular`、`IconRefreshOutlineRegular` 替换裸 `<button>` | ~15 行 |
| 6 | `scripts/register.mjs` | 追加 symlink 创建（幂等），否则换机安装还是解析不到 | ~10 行 |
| 7 | 部署 | `cp -r <PLUGIN> ~/.dsh/plugins/dsh-user-profile`（或 symlink 反向），然后**重启 dsh** | 2 条命令 |

总计新增/改动 ≈ **90 行**，不新增任何文件类型；`docs/` 目录本身是新建的（本笔记）。

### 7.3 验收步骤（照抄即可）

```bash
# 1) 解析
cd ~/.dsh/profiles/desktop && node -e "import.meta.resolve('dsh-user-profile')"
# 2) bundle 至少语法合法
node --check ~/.dsh/plugins/dsh-user-profile/client.js
# 3) 路由在（需要 cookie；无 cookie 应 401）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:52442/user-profile/panel.json
```

浏览器侧：设置 → 左侧应出现「用户画像」一项（`order: 55`，排在 general(0)/models(10)/agent-presets(20) 之后）。Console 里 `document.querySelector('style[data-plugin]')` 与 `window.__ModuleLoader__` 存在；若面板显示"host 插件未加载"，先查 0 节。

---

## 8. 未找到 / 未验证（明确标注，不作猜测）

- **`ctx.settings.*`、`ctx.webUi.*`、`ctx.client.settings.*` 均不存在**；client 服务只有 8 个（§2.1 逐条来自 API 目录）。
- **`@deepseek-ai/dsh-web-ui` 包不存在**（`ls -d` 直接报 No such file or directory）。
- **无 Table/DataTable 组件**、无 Tailwind 运行时；无「把 HTML 注册进设置页」的 API。
- `<CHECKOUT>` 下**无 `docs/` 目录**，本机也没有 tsdown/rolldown/`.bin`，官方构建命令（`pnpm run build`）在本机不可用；本笔记的 bundle 结论全部来自运行期契约与真实产物，不依赖构建文档。
- `host.call(method, args)`（`dsh-cordis-client-runner/lib/client.js:7049`）是否在本机对外暴露，**未验证**。
- 设置页导航**不读 icon**（只看 id/order/label），所以别指望给 section 配图标。
- `client.js` 当前 `ENDPOINT` 带前导 `/`：直连 `127.0.0.1:52442` 没问题；若将来经反代子路径访问，改成 `'user-profile/panel.json'`（§3.2 写法 A）更稳。
