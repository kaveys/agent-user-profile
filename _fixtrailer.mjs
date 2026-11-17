import { readFileSync, writeFileSync } from "node:fs"
const f = "scripts/build-trailer.ps1"
let t = readFileSync(f, "utf8"); const b = t

// RoundRect 的填充色不能把 (a,b,c) 元组当单个参数传，先算出颜色变量
t = t.replace(
`        RoundRect $g ($cx + S(44)) ($cy + S(44)) (S(150)) (S(56)) (S(14)) ([Drawing.Color]::FromArgb(46, $c[2]), $null, 0)`,
`        $chip = [Drawing.Color]::FromArgb(46, $c[2])
        RoundRect $g ($cx + S(44)) ($cy + S(44)) (S(150)) (S(56)) (S(14)) $chip`)

t = t.replace(
`        RoundRect $g ($px + S(56)) ($ry + S(30)) (S(110)) (S(44)) (S(12)) ([Drawing.Color]::FromArgb(46, $C.accent), $null, 0)`,
`        $chip2 = [Drawing.Color]::FromArgb(46, $C.accent)
        RoundRect $g ($px + S(56)) ($ry + S(30)) (S(110)) (S(44)) (S(12)) $chip2`)

if (t === b) { console.error("no change"); process.exit(1) }
writeFileSync(f, t); console.log("RoundRect fill fixed")
