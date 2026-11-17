import { readFileSync, writeFileSync } from "node:fs"
const f = "scripts/build-trailer.ps1"
let t = readFileSync(f, "utf8")
// PowerShell 里函数的返回值不能直接参与 `+` / `-` 运算（需额外括号），
// 所以把 S(n) 一律展开成 (n * $U)：既消掉这个坑，也少一层调用。
const before = t
t = t.replace(/\bS\((\d+(?:\.\d+)?)\)/g, "($1 * $U)")
// 删掉已经不再使用的 S 函数定义
t = t.replace(/function S\(\[double\]\$v\) \{ \[single\]\(\$v \* \$U\) \}\r?\n/, "")
if (t === before) { console.error("no change"); process.exit(1) }
writeFileSync(f, t)
console.log("S() inlined:", (before.match(/\bS\(/g) || []).length, "call sites")
