import { readFileSync, writeFileSync } from "node:fs"
const f = "scripts/build-trailer.ps1"
let t = readFileSync(f, "utf8")
const b = t
// 复用仓库里的 scripts/tts.py，避免两份实现漂移
t = t.replace(`$ttsPy = Join-Path $Work 'tts.py'`, `$ttsPy = Join-Path $Root 'scripts/tts.py'`)
// 删掉内联写文件的那段（$ttsPy ... Set-Content $ttsPy -Encoding UTF8）
t = t.replace(/\$ttsPy = Join-Path \$Work 'tts\.py'\n@'[\s\S]*?'@ \| Set-Content \$ttsPy -Encoding UTF8\n/, "")
if (t === b) { console.error("no change"); process.exit(1) }
writeFileSync(f, t)
console.log("tts helper reused")
