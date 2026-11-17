import { readFileSync, writeFileSync } from "node:fs"
const f = "scripts/build-trailer.ps1"
let t = readFileSync(f, "utf8"); const b = t
const fixes = [
  ["($W - S(180))", "($W - (S(180)))"],
  ["($px + $pw - S(250))", "($px + $pw - (S(250)))"],
  ["($px + $pw - S(206))", "($px + $pw - (S(206)))"],
  ["($pw - S(72))", "($pw - (S(72)))"],
  ["($py + $ph - S(56))", "($py + $ph - (S(56)))"],
]
for (const [from, to] of fixes) t = t.split(from).join(to)
if (t === b) { console.error("no change"); process.exit(1) }
writeFileSync(f, t)
console.log("arithmetic parentheses fixed")
