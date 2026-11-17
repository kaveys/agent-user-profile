# v16：真实检测 + 脱敏 + 旁白短片 + 一键发布

## 一、真实检测（不只是跑脚本）

| 层面 | 做了什么 | 结果 |
| --- | --- | --- |
| 语法 | 11 个文件 `node --check` | 全 0 |
| 单元 | `tests/selftest.mjs` | 全通过（含并发写、陈旧锁、去重、drift、提炼 key 复用） |
| 端到端（真实进程） | `tests/e2e.mjs` A 段 26 项 | 26/26 |
| 端到端（真实 HTTP） | `tests/e2e.mjs` 全量（对运行中的宿主） | **42/42** |
| 对抗 | `tests/audit-1.mjs` / `tests/audit-2.mjs` | 33/33、21/21 |
| 渲染 | `tests/render.mjs` | 全通过 |
| 安装体检 | `scripts/verify-install.mjs` | 13/13 |
| **真机操作** | 点开设置 → 用户画像 → 条目页，用 UIA `invoke` 点第一条的 `＋` | `confidence 0.9 → 1`，`declarations.jsonl` 落盘同步 |
| **真机操作** | 同一条点 `－` | 回到 `0.9`，画像即时重建 |
| **真机操作** | 切「备份与重置」页 | 新增「体检 · 脱敏 · 云端备份」区正常渲染 |
| 真实数据 | `profile validate` | 检查 15 条，不合格 0 条 |
| 真实数据 | `profile redact` | 15 条，0 处敏感内容 |
| 真实数据 | `profile backup --out %TEMP%\bak-…` | 导出 18 KB 备份包，15 条声明 |
| 真实数据 | `profile backup --dry-run`（未配 WebDAV） | 明确报错并给出两种填法 |

已知一条待重启：`validate / redact / backup` 三个**面板按钮**对应宿主新 action，运行中的 index.js 还是旧版，点了会返回 `400 未知动作`（已实测确认）。CLI 侧不受影响。

## 二、上传前脱敏

- 所有被 git 跟踪的文本文件：`C:\Users\<用户名>` → `<home>`，项目绝对路径 → `<repo>`，用户名 → `dev`，提交作者统一改写为 `agent-user-profile <dev@example.com>`（`git filter-branch`，历史 7 个提交全部重写）。
- 七张截图裁成只留设置面板内容区（700×820），左侧栏的项目名、会话标题、用户名一律不入镜。
- `.gitignore` 排除 `*.jsonl`、`snapshots/`、`archive/`、`user-profile/` 等本机数据目录，仓库里不含任何真实画像条目。
- 插件自身 `redact` 能力默认开启（手机号 / 邮箱 / 证件号 / 密钥），写入前打码。

## 三、旁白短片

- 产物：`docs/video/intro-60s.mp4` —— 58 秒，1280×720，30fps，H.264 + AAC 单声道中文旁白（Microsoft Huihui）。
- 生成脚本：`scripts/build-video.ps1`（GDI+ 出图 + SAPI 配音 + ffmpeg 合成，全离线，无第三方素材）。
- 七场结构：标题 → 问题 → 概览（自动叠加）→ 条目（权重可调）→ 纯 CLI → 四个能力 → 结尾地址。
- 旧的无旁白 39 秒版本保留为 `docs/video/intro.mp4`。

## 四、一键发布

`scripts/publish-github.ps1`：检测登录 → 未登录则设备码登录 → 把 `package.json`/README 里的 `OWNER` 换成真实用户名并提交 → `gh repo create` → `git push`（HTTPS 失败自动重试 3 次，再退到 `ssh://git@ssh.github.com:443`）。

> 本机 `github.com:443` 的 git 传输不稳（`Recv failure: Connection was reset` / 21 秒超时），`api.github.com` 与 `ssh.github.com:443` 可达。设备码登录当前卡在等待授权，需要账号本人确认。

## 五、仍未做

- 面板三个新按钮要重启 DSH 才注册（重启后自动生效）。
- 短片只有中文旁白；英文版需要另配英文语音。
