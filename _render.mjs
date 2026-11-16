/**
 * client.js 渲染烟测：不依赖宿主、不开浏览器。
 *
 * 为什么要这个：设置页 bundle 是手写的（没有构建、没有类型检查），
 * 只有 node --check 只能证明「语法对」，证明不了「渲染不炸」。
 * 这里用一套极小的 hooks 运行时（useState/useCallback/useEffect/createElement）
 * 把真正的 ProfileSection 渲染成树，逐个页签走一遍，抓运行时错误与文案缺失。
 *
 * 用法：node _render.mjs
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'bin', 'profile.mjs')

let failures = 0
const check = (name, ok, detail) => {
  if (ok) {
    process.stdout.write(`  PASS  ${name}\n`)
  } else {
    failures += 1
    process.stdout.write(`  FAIL  ${name}${detail === undefined ? '' : `\n        ${detail}`}\n`)
  }
}

// ---------------------------------------------------------------- 假 React

let hookStore = []
let hookCursor = 0
let dirty = false
let effects = []
// 每个函数组件一份自己的 hooks 存放区（按组件函数身份区分），
// 否则父组件与子组件会抢同一个 slot —— 那是假失败，不是代码有问题。
const stores = new Map()

function renderComponent(type, props) {
  const savedStore = hookStore
  const savedCursor = hookCursor
  hookStore = stores.get(type) ?? []
  hookCursor = 0
  const output = type(props ?? {})
  stores.set(type, hookStore)
  hookStore = savedStore
  hookCursor = savedCursor
  return output
}

function useState(initial) {
  const index = hookCursor
  hookCursor += 1
  // setter 必须绑住「它自己那份 store」：effect 里的异步回调执行时，
  // 全局 hookStore 早就切到别的组件了，按全局写会写错地方。
  const store = hookStore
  if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
  const setter = (next) => {
    const value = typeof next === 'function' ? next(store[index]) : next
    if (value !== store[index]) {
      store[index] = value
      dirty = true
    }
  }
  return [store[index], setter]
}

function useCallback(fn) {
  return fn
}

function useEffect(fn) {
  effects.push(fn)
}

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
  // React 把子节点放在 props.children 里，函数组件靠解构拿——少了这一步，
  // 任何 <Section>{...}</Section> 形式的组件都会渲染成空壳。
  const withChildren = { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat }
  return { type, props: withChildren, children: flat }
}

const ReactStub = { useState, useCallback, useEffect, createElement }

// ---------------------------------------------------------------- 假宿主

const panelJson = execFileSync(process.execPath, [CLI, 'panel'], { encoding: 'utf8', timeout: 20000 })
const panel = JSON.parse(panelJson)
check('payload 不再包含存储路径', panel.paths === undefined)
check('payload 不再包含活跃/工具统计', panel.activity === undefined && panel.toolMix === undefined && panel.hours === undefined)
check('payload 统计只剩面向用户的键', !Object.prototype.hasOwnProperty.call(panel.stats ?? {}, 'avgSteps') && !Object.prototype.hasOwnProperty.call(panel.stats ?? {}, 'toolCalls'))
check('payload 带恢复点列表', Array.isArray(panel.snapshots), `snapshots=${Array.isArray(panel.snapshots) ? panel.snapshots.length : 'missing'}`)

const fetchStub = async (url) => {
  if (String(url).startsWith('/user-profile/panel.json')) {
    return { ok: true, status: 200, json: async () => panel }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, output: 'stub' }) }
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}
globalThis.fetch = fetchStub

// ---------------------------------------------------------------- 加载 bundle

const source = readFileSync(join(HERE, 'client.js'), 'utf8')
// bundle 是浏览器脚本（非 ESM），用 Function 在受控作用域里执行
new Function('window', 'fetch', 'require', source)(globalThis.window, fetchStub, (name) => {
  if (name === 'react') return ReactStub
  throw new Error(`bundle 试图 require 宿主包：${name}`)
})

check('bundle 注册了模块', captured !== null && captured.id === 'dsh-user-profile')
const mod = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`factory 试图 require 宿主包：${name}`)
})
check('导出 apply', typeof mod.apply === 'function')
check('导出 inject = [slots]', Array.isArray(mod.inject) && mod.inject[0] === 'slots')

// ---------------------------------------------------------------- 抓注册的组件

let section = null
let registration = null
const ctx = {
  slots: {
    inject(key, callback) {
      callback()
    },
    register(options, component) {
      registration = options
      section = component
    },
  },
}
mod.apply(ctx)
check('注册到 settings.section', registration?.name === 'settings.section')
check('section id = user-profile', registration?.id === 'user-profile')
check('label 返回「用户画像」', registration?.label?.() === '用户画像')

// ---------------------------------------------------------------- 渲染

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(renderComponent(node.type, node.props))
  return (node.children ?? []).map(textOf).join(' ')
}

async function settle(Component, props) {
  effects = []
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    dirty = false
    tree = renderComponent(Component, props)
    const pending = effects
    effects = []
    for (const effect of pending) effect()
    // 等待异步 load() 落地后重渲染
    await new Promise((resolve) => setTimeout(resolve, 40))
    if (!dirty) break
  }
  return tree
}

const tabs = ['概览', '条目', '待审', '冲突与历史', '维度', '设置', '备份与重置']
const seen = {}

for (const tab of tabs) {
  // 通过点击页签按钮切换：找到标签为 tab 的按钮并调用它的 onClick
  let tree = await settle(section, {})
  const press = (node) => {
    if (node === null || node === undefined || node === false) return false
    if (Array.isArray(node)) return node.some(press)
    if (typeof node !== 'object') return false
    // 页签上有计数时文案是「冲突与历史 1」，所以用前缀匹配
    if (node.type === 'button' && textOf(node).trim().startsWith(tab) && typeof node.props?.onClick === 'function') {
      node.props.onClick()
      return true
    }
    if (typeof node.type === 'function') return false
    return (node.children ?? []).some(press)
  }
  const pressed = press(tree)
  if (pressed) {
    // 页签状态变更后再渲染一次
    for (let pass = 0; pass < 3; pass += 1) {
      dirty = false
      tree = renderComponent(section, {})
      for (const effect of effects) effect()
      effects = []
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    tree = renderComponent(section, {})
  }
  let text = ''
  try {
    text = textOf(tree)
  } catch (error) {
    check(`页签「${tab}」渲染`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
    continue
  }
  seen[tab] = text

  check(`页签「${tab}」渲染出内容`, text.length > 20, text.slice(0, 120))
}

// 每个页签至少要有它自己的关键文案，防止「切了页签但内容没变」
const expectations = {
  概览: ['画像条目', '你确认过的', '优先级分布', '当前策略'],
  条目: ['全部维度', '按权重', '条'],
  待审: ['待审候选', '候选'],
  冲突与历史: ['冲突判定', '历史留档'],
  维度: ['画像大类', '新增维度'],
  设置: ['每次任务前自动参考画像', '保存并重建', '自动合并重复条目', 'WebDAV 地址'],
  备份与重置: ['恢复点', '导出备份', '批量导入', '体检条目', '扫描敏感信息', '上传到 WebDAV'],
}
for (const [tab, needles] of Object.entries(expectations)) {
  const text = seen[tab] ?? ''
  const missing = needles.filter((needle) => !text.includes(needle))
  check(`页签「${tab}」关键文案齐全`, missing.length === 0, missing.length === 0 ? undefined : `缺少：${missing.join('、')}`)
}

// 外壳：状态胶囊 + 版本行 + 主行动按钮，任何页签都在
const shellText = seen['概览'] ?? ''
check('外壳显示状态与版本行', shellText.includes('条已确认') && shellText.includes('按优先级排列'), shellText.slice(0, 120))
check('外壳有「立即更新」主按钮', shellText.includes('立即更新'))
// 权重可改：条目页每行都有 +/- 步进，编辑态有权重输入框
const itemText = seen['条目'] ?? ''
check('条目页有权重加减按钮', itemText.includes('＋') && itemText.includes('－'), itemText.slice(0, 80))
check('条目页显示权重等级（高/中/低）', /高|中|低/.test(itemText))
// 溯源：条目副行要说清「这条是谁说的、什么时候」的形态（数据里有 provenance 才显示）
check('条目页副行保留更新时间', itemText.includes('更新于'), itemText.slice(0, 80))
check('备份页有体检 / 脱敏 / 备份三组入口', /体检条目/.test(seen['备份与重置'] ?? '') && /脱敏/.test(seen['备份与重置'] ?? '') && /WebDAV/.test(seen['备份与重置'] ?? ''))

process.stdout.write(failures === 0 ? '\n渲染烟测全部通过\n' : `\n渲染烟测失败 ${failures} 项\n`)
process.exit(failures === 0 ? 0 : 1)






