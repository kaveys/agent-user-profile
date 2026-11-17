import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
const f="README.md"; let t=readFileSync(f,"utf8"); const b=t
t=t.replace("v20 新增两块", "v21：`set` 能改的键，面板一定看得到（双向核对）；v20 新增两块")
if(t===b){ console.log("README: anchor missing, skip") } else { writeFileSync(f,t); console.log("README updated") }
for (const p of ["_fixPayload.mjs","_fixPayload2.mjs","_fixPayload3.mjs","_dupcheck.mjs","_fixA5.mjs","_fixA5b.mjs","_sync21.mjs"]) {
  try { unlinkSync(p); console.log("removed", p) } catch {}
}
