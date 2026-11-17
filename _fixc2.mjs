import { readFileSync, writeFileSync } from "node:fs"
const f = "scripts/build-trailer.ps1"
let t = readFileSync(f, "utf8"); const b = t
t = t.replace("((32 * $U)) $c[2] $true", "((32 * $U)) $cell[2] $true")
if (t === b) { console.error("no change"); process.exit(1) }
writeFileSync(f, t); console.log("fixed remaining $c[2]")
