import { readFileSync, writeFileSync } from "node:fs"
const f = "bin/profile.mjs"
let t = readFileSync(f, "utf8")
const before = t
t = t.replace("health: healthOf(config, declarationsAll, profile),", "health: healthOf(config, readJsonl(p(\"declarations.jsonl\")), profile),")
if (t === before) { console.error("no change"); process.exit(1) }
writeFileSync(f, t)
console.log("panel health fixed")
