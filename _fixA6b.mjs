import { readFileSync, writeFileSync } from "node:fs"
const f="_audit6.mjs"; let t=readFileSync(f,"utf8"); const b=t
// 相似句会被去重合并（这是设计），测试数据必须彼此不像，否则测不到预算逻辑
t=t.replace(`  for (let i = 0; i < 6; i += 1) cli(['declare', '--dim', 'constraints', '--fact', \`约束\${i}必须遵守第\${i}条外部规则\`, '--core'])
  for (let i = 0; i < 6; i += 1) cli(['declare', '--dim', 'taste', '--fact', \`口味\${i}偏好第\${i}种视觉风格\`])`,
`  const hard = ['上传前必须彻底脱敏', '不同插件职责严格独立', '删数据要能一键恢复', '真机跑通才算完成', '先给结论再给过程', '不许静默丢数据']
  const soft = ['界面要有留白和层次', '配色偏冷色低饱和', '文案用短句不用长段', '桌面图标尽量少', '动画克制不炫技', '深色模式优先']
  for (const fact of hard) cli(['declare', '--dim', 'constraints', '--fact', fact, '--core'])
  for (const fact of soft) cli(['declare', '--dim', 'taste', '--fact', fact])`)
if(t===b){console.error("no change");process.exit(1)}
writeFileSync(f,t); console.log("D seeds made distinct")
