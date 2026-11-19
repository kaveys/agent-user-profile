# 遇到问题怎么办

先看下面四条，八成能自己解决。都不行再开 issue，别急。

## 1. 装完没反应 / 设置里看不到「用户画像」

```bash
node scripts/verify-install.mjs
```

它会把每一项契约逐条打出来（`PASS` / `SKIP` / `FAIL`）。最常见的原因是**没重启**——插件注册表和面板新按钮都在启动时读，改完文件必须重启 DSH。

## 2. 画像一直是空的

- 清单至少要 **3 条**才会被注入（防止刚装就塞一段空壳）。
- 想立刻看到效果：`node bin/profile.mjs declare --dim taste --fact "喜欢简洁的界面"` 然后 `node bin/profile.mjs build`。
- 想知道为什么某条没被带上：`node bin/profile.mjs explain --text "你这次的任务描述"`。

## 3. 数据不对 / 想回滚

- 看现状：`node bin/profile.mjs status`、`node bin/profile.mjs show --with-keys`
- 找回恢复点：`node bin/profile.mjs snapshots`，然后 `node bin/profile.mjs restore <名字>`
- 面板「备份与重置」页也有同样的按钮，可整批还原。

## 4. 换了宿主版本，某些功能降级了

```bash
node bin/profile.mjs doctor
```

它列出 6 项宿主能力各自「可用 / 缺失」，以及缺失后哪些功能会降级。对照表在 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 还是不行：开 issue

请在 [issues](https://github.com/kaveys/agent-user-profile/issues) 里带上：

1. `node bin/profile.mjs doctor` 的输出
2. `node scripts/verify-install.mjs` 的输出
3. 你做了什么、期望什么、实际什么
4. 宿主版本（DSH 桌面版「关于」里能看到）

**贴之前先打码**：本地路径、用户名、真实画像内容、证件号、密钥。报安全问题的走 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 想改代码

看 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前跑一遍：

```bash
npm test        # 等价于 node scripts/test-all.mjs
```
