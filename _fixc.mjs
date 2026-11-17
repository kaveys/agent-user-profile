import { readFileSync, writeFileSync } from "node:fs"
const f = "scripts/build-trailer.ps1"
let t = readFileSync(f, "utf8"); const b = t
// PowerShell 变量名大小写不敏感：$c 与调色板 $C 是同一个变量，循环里会把调色板覆盖掉。
t = t.replace("foreach ($c in $cells) {", "foreach ($cell in $cells) {")
t = t.replace("($cx + (44 * $U)) ($cy + (44 * $U)) ((150) * $U) ((56) * $U) ((14) * $U) $chip",
              "($cx + (44 * $U)) ($cy + (44 * $U)) ((150) * $U) ((56) * $U) ((14) * $U) $chip")
t = t.replace("$chip = [Drawing.Color]::FromArgb(46, $c[2])", "$chip = [Drawing.Color]::FromArgb(46, $cell[2])")
t = t.replace("Txt $g $c[0] ", "Txt $g $cell[0] ")
t = t.replace("(32 * $U) $c[2] $true", "(32 * $U) $cell[2] $true")
t = t.replace("Txt $g $c[1] ", "Txt $g $cell[1] ")
if (t === b) { console.error("no change"); process.exit(1) }
writeFileSync(f, t); console.log("loop variable renamed ($c -> $cell)")
