## 这个 PR 做了什么

<!-- 一两句说清楚。如果是修 bug，写上复现步骤。 -->

## 类型

- [ ] 修 bug
- [ ] 新功能
- [ ] 文档 / 注释
- [ ] 重构（不改行为）
- [ ] 测试

## 提交前检查

- [ ] `npm test` 全绿（= `node scripts/test-all.mjs`，含 audit-1…14、selftest、render、compat、e2e、verify-install）
- [ ] 没提交任何真实数据：本地路径、用户名、真实画像条目、证件号、密钥
- [ ] 改了判定逻辑的话，`node tests/audit-10.mjs` 仍然通过（它是决定论与幂等的守门人）
- [ ] 改了面板或文案的话，说明截图（`docs/screenshots/`）是否需要更新
- [ ] CHANGELOG 里加了一段（`## Unreleased` 下面）

## 影响面

<!-- 哪些行为会变？会不会影响已经落盘的数据？回滚方式是什么？ -->

## 相关 issue

<!-- 例如：Closes #12 -->
