import { readFileSync, writeFileSync } from 'node:fs'

const file = 'bin/profile.mjs'
let t = readFileSync(file, 'utf8')
const block = readFileSync('_block.txt', 'utf8')
const before = t

if (!t.includes('function cmdExplain(')) {
  t = t.replace('function cmdPanel() {', `${block}\nfunction cmdPanel() {`)
}
if (!t.includes('  explain: cmdExplain,')) {
  t = t.replace('  validate: cmdValidate,', '  validate: cmdValidate,\n  explain: cmdExplain,\n  health: cmdHealth,')
}
// panel payload 里带上健康度与宿主能力，面板才有东西可画
if (!t.includes('health: healthOf(')) {
  t = t.replace(
    "    drift,",
    "    drift,\n    health: healthOf(config, declarationsAll, profile),",
  )
}

if (t === before) {
  console.error('no change (already patched?)')
  process.exit(1)
}
writeFileSync(file, t)
console.log('inserted: explain=', t.includes('function cmdExplain('), 'health=', t.includes('function cmdHealth('), 'panel=', t.includes('health: healthOf('))
