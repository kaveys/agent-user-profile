/**
 * 用户画像 · 设置页面板（浏览器 bundle）
 *
 * 形态契约（见 dsh-doc/templates/decoration/client.js）：
 *   浏览器里没有 ESM，宿主用 window.__ModuleLoader__.load({ id, factory }) 装载；
 *   id 必须等于包名；factory 不能有副作用；React 由模块表提供（require('react')）。
 *
 * 数据契约：GET /user-profile/panel.json（host 侧 execFileSync 调 bin/profile.mjs panel）
 *           POST /user-profile/action（declare/edit/forget/merge/review/dims/settings/importText/export/reset/build）
 *
 * 三条硬规则：
 *   1. 只 require('react')，不 require 任何宿主客户端包；
 *   2. 着色只用 --dsw-alias-* 主题变量，亮/暗主题自动跟随；
 *   3. 所有写操作都走后端 CLI，前端不猜结果——失败就把 CLI 原文摆给用户看。
 */
window.__ModuleLoader__.load({
  id: 'dsh-user-profile',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/user-profile/panel.json'
    const ACTION = '/user-profile/action'

    const T = {
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      caption: 'var(--dsw-alias-label-caption)',
      border2: 'var(--dsw-alias-border-l2)',
      border1: 'var(--dsw-alias-border-l1)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      warnBg: 'var(--dsw-alias-state-warn-tertiary)',
      success: 'var(--dsw-alias-state-success-primary)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
    }

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '24px', padding: '30px 0 48px', color: T.label1 },
      head: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '17px', fontWeight: 600, letterSpacing: '-0.01em', margin: 0, color: T.label1 },
      meta: { fontSize: '12px', color: T.label3, lineHeight: 1.65 },
      spacer: { flex: 1 },
      button: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.6,
        padding: '5px 12px',
        borderRadius: '8px',
        border: `1px solid ${T.border2}`,
        background: 'transparent',
        color: T.label1,
        cursor: 'pointer',
      },
      buttonPrimary: { border: `1px solid ${T.brand}`, background: 'transparent', color: T.brand, fontWeight: 600 },
      buttonDanger: { border: `1px solid ${T.error}`, color: T.error },
      buttonMini: { fontSize: '11px', padding: '1px 7px', borderRadius: '5px' },
      busy: { opacity: 0.55, cursor: 'default' },
      tabs: { display: 'flex', gap: '18px', borderBottom: `1px solid ${T.border1}`, flexWrap: 'wrap' },
      tab: {
        font: 'inherit',
        fontSize: '12.5px',
        padding: '9px 1px',
        border: 'none',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: T.label3,
        cursor: 'pointer',
      },
      tabActive: { color: T.label1, borderBottom: `2px solid ${T.brand}`, fontWeight: 600 },
      card: { border: `1px solid ${T.border1}`, borderRadius: '12px', padding: '18px', background: T.layer1 },
      metrics: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: '12px' },
      metric: { border: `1px solid ${T.border1}`, borderRadius: '10px', padding: '14px 16px', background: T.layer1 },
      metricLabel: { fontSize: '11px', color: T.label3, letterSpacing: '0.02em' },
      metricValue: { fontSize: '24px', fontWeight: 600, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums', marginTop: '4px', color: T.label1 },
      metricHint: { fontSize: '11px', color: T.caption, marginTop: '2px', lineHeight: 1.5 },
      h2: { fontSize: '13px', fontWeight: 600, letterSpacing: '0.01em', margin: 0, color: T.label1 },
      h3: { fontSize: '12px', fontWeight: 600, margin: '0 0 4px', color: T.label2 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
      th: {
        textAlign: 'left',
        fontWeight: 600,
        fontSize: '11px',
        color: T.label3,
        padding: '8px 10px',
        borderBottom: `1px solid ${T.border2}`,
        whiteSpace: 'nowrap',
      },
      thRight: {
        textAlign: 'right',
        fontWeight: 600,
        fontSize: '11px',
        color: T.label3,
        padding: '6px 8px',
        borderBottom: `1px solid ${T.border2}`,
        whiteSpace: 'nowrap',
      },
      td: { padding: '10px', borderBottom: `1px solid ${T.border1}`, verticalAlign: 'top', color: T.label1 },
      tdRight: { padding: '10px', borderBottom: `1px solid ${T.border1}`, textAlign: 'right', whiteSpace: 'nowrap' },
      mono: { fontFamily: mono, fontSize: '11px', color: T.label3 },
    weightRow: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' },
    step: {
      minWidth: '20px',
      height: '20px',
      padding: '0 4px',
      borderRadius: '6px',
      border: '1px solid ' + T.border2,
      background: 'transparent',
      color: T.label2,
      fontSize: '12px',
      lineHeight: 1,
      cursor: 'pointer',
    },
      badge: {
        display: 'inline-block',
        fontSize: '10px',
        lineHeight: 1.7,
        padding: '0 5px',
        borderRadius: '4px',
        border: `1px solid ${T.border2}`,
        color: T.label3,
        marginLeft: '7px',
        whiteSpace: 'nowrap',
      },
      badgeCore: { borderColor: T.brand, color: T.brand },
      badgeWarn: { borderColor: T.warn, color: T.warn },
      badgeError: { borderColor: T.error, color: T.error },
      barTrack: { height: '6px', borderRadius: '999px', background: T.border1, overflow: 'hidden', minWidth: '48px' },
      barFill: { height: '100%', borderRadius: '3px', background: T.brand },
      input: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 7px',
        borderRadius: '6px',
        border: `1px solid ${T.border2}`,
        background: 'transparent',
        color: T.label1,
        minWidth: 0,
      },
      select: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 6px',
        borderRadius: '6px',
        border: `1px solid ${T.border2}`,
        background: 'transparent',
        color: T.label1,
      },
      textarea: {
        fontFamily: mono,
        fontSize: '11px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: `1px solid ${T.border2}`,
        background: 'transparent',
        color: T.label1,
        width: '100%',
        minHeight: '88px',
        resize: 'vertical',
      },
      toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      formRow: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 190px', minWidth: '150px' },
      fieldLabel: { fontSize: '11px', color: T.label3 },
      fieldHint: { fontSize: '10px', color: T.caption, lineHeight: 1.5 },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '10px' },
      note: { fontSize: '11px', color: T.label3, lineHeight: 1.65 },
      notice: { fontSize: '12px', color: T.label2, whiteSpace: 'pre-wrap', padding: '8px 12px', borderRadius: '8px', background: T.layer2 },
      warnLine: { fontSize: '12px', color: T.warn, whiteSpace: 'pre-wrap' },
      empty: { fontSize: '12px', color: T.label3, padding: '18px 0', lineHeight: 1.7 },
      listRow: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '7px 0', borderBottom: `1px solid ${T.border1}` },
      dimRow: { display: 'grid', gridTemplateColumns: '1fr 96px 96px auto', gap: '10px', alignItems: 'center', padding: '6px 0' },
      spark: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '46px' },
      sparkBar: { width: '12px', borderRadius: '2px 2px 0 0', background: T.brand, opacity: 0.75 },
      // ---- v10 视觉层：横幅、策略两列 ----
      saveBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        border: `1px solid ${T.brand}`,
        background: T.layer1,
        position: 'sticky',
        top: '34px',
        zIndex: 1,
      },
      banner: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        border: `1px solid ${T.border2}`,
        background: T.layer2,
        fontSize: '12px',
        color: T.label2,
      },
      bannerDot: { width: '6px', height: '6px', borderRadius: '50%', background: T.warn, flex: '0 0 auto' },
      strategyRow: {
        display: 'grid',
        gridTemplateColumns: '88px 1fr',
        gap: '10px',
        alignItems: 'baseline',
        padding: '7px 0',
        borderBottom: `1px solid ${T.border1}`,
      },
      strategyLabel: { fontSize: '12px', color: T.label3, whiteSpace: 'nowrap' },
      strategyValue: { fontSize: '12px', color: T.label2, lineHeight: 1.6 },
      // ---- v9 视觉层：胶囊状态、粘性页签、骨架、可点区域反馈 ----
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '11px',
        lineHeight: 1.5,
        padding: '1px 8px',
        borderRadius: '999px',
        border: `1px solid ${T.border2}`,
        color: T.label2,
        whiteSpace: 'nowrap',
      },
      pillDot: { width: '6px', height: '6px', borderRadius: '50%', background: T.label3, flex: '0 0 auto' },
      stickyTabs: {
        display: 'flex',
        gap: '22px',
        borderBottom: `1px solid ${T.border2}`,
        flexWrap: 'wrap',
        position: 'sticky',
        top: 0,
        zIndex: 2,
        background: T.layer1,
        paddingTop: '2px',
        marginTop: '-6px',
      },
      tabCount: {
        display: 'inline-block',
        marginLeft: '5px',
        fontSize: '10px',
        lineHeight: '15px',
        minWidth: '15px',
        padding: '0 4px',
        borderRadius: '999px',
        background: T.layer2,
        color: T.label3,
      },
      skeleton: {
        height: '12px',
        borderRadius: '6px',
        background: T.layer2,
        marginBottom: '10px',
      },
      ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
      rowBetween: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      dangerZone: { border: `1px solid ${T.border2}`, borderRadius: '8px', padding: '10px 12px', background: T.layer2 },
      snapRow: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${T.border1}` },
      tag: {
        fontFamily: mono,
        fontSize: '10px',
        padding: '0 5px',
        borderRadius: '4px',
        background: T.layer2,
        color: T.label3,
      },
    }

    // ---------------------------------------------------------------- 传输

    async function fetchPanel() {
      const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error(`后端返回 ${response.status}（host 插件没加载时会出现这个）`)
      const data = await response.json()
      if (data?.ok === false) throw new Error(String(data.error ?? '后端返回失败'))
      return data
    }

    async function postAction(payload) {
      const response = await fetch(ACTION, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) throw new Error(data?.error ?? `后端返回 ${response.status}`)
      if (data?.ok === false) throw new Error(String(data.error ?? '动作失败'))
      return data
    }

    // ---------------------------------------------------------------- 小组件

    function Badge({ text, tone }) {
      const extra = tone === 'core' ? styles.badgeCore : tone === 'warn' ? styles.badgeWarn : tone === 'error' ? styles.badgeError : null
      return h('span', { style: extra === null ? styles.badge : { ...styles.badge, ...extra } }, text)
    }

    /** 没有样式表，hover/active 只能靠状态做 —— 手感全靠它。 */
    function Btn({ children, onClick, tone, disabled, mini, title }) {
      const [hover, setHover] = React.useState(false)
      const base = mini ? { ...styles.button, ...styles.buttonMini } : styles.button
      const toned = tone === 'primary' ? { ...base, ...styles.buttonPrimary }
        : tone === 'danger' ? { ...base, ...styles.buttonDanger }
          : base
      const state = disabled ? { opacity: 0.5, cursor: 'default' }
        : hover ? { background: T.hover } : { background: 'transparent' }
      return h('button', {
        style: { ...toned, ...state, transition: 'background 120ms ease' },
        disabled: disabled === true,
        title,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: disabled === true ? undefined : onClick,
      }, children)
    }

    /** 状态胶囊：颜色只在语义真的需要时才用。 */
    function StatusPill({ profile, items }) {
      const status = profile?.status ?? 'missing'
      const map = {
        ready: { text: '已就绪', color: T.success },
        insufficient: { text: '证据还少', color: T.warn },
        empty: { text: '还是空的', color: T.warn },
        missing: { text: '未生成', color: T.label3 },
      }
      const picked = map[status] ?? map.missing
      return h('span', { style: styles.pill },
        h('span', { style: { ...styles.pillDot, background: picked.color } }),
        picked.text,
        h('span', { style: { color: T.caption } }, `${items ?? 0} 条`))
    }

    function Bar({ ratio, tone }) {
      const width = `${Math.max(0, Math.min(1, Number(ratio) || 0)) * 100}%`
      const fill = tone === 'warn' ? { ...styles.barFill, background: T.warn } : styles.barFill
      return h('div', { style: styles.barTrack }, h('div', { style: { ...fill, width } }))
    }

    function Metric({ label, value, hint, tone }) {
      const color = tone === 'warn' ? T.warn : tone === 'error' ? T.error : tone === 'brand' ? T.brand : T.label1
      // 主指标（tone='brand'）左侧压一条 2px 品牌色，一眼能分出「这是重点数字」
      const accent = tone === 'brand' ? { borderLeft: `2px solid ${T.brand}` } : null
      return h('div', { style: accent ? { ...styles.metric, ...accent } : styles.metric },
        h('div', { style: styles.metricLabel }, label),
        h('div', { style: { ...styles.metricValue, color } }, value),
        hint === undefined || hint === null || hint === '' ? null : h('div', { style: styles.metricHint }, hint))
    }

    function Field({ label, hint, children }) {
      return h('label', { style: styles.field },
        h('span', { style: styles.fieldLabel }, label),
        children,
        hint === undefined || hint === null || hint === '' ? null : h('span', { style: styles.fieldHint }, hint))
    }

    function Section({ title, extra, children }) {
      return h('div', { style: styles.card },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '12px' } },
          h('div', { style: styles.h2 }, title),
          h('div', { style: styles.spacer }),
          extra === undefined || extra === null ? null : extra),
        children)
    }

    /** 权重是内部数值，界面上只讲「高 / 中 / 低」。 */
    function nextWeight(current, delta) {
      const base = Number.isFinite(Number(current)) ? Number(current) : 0.6
      const next = Math.round((base + delta) * 100) / 100
      return Math.min(1, Math.max(0.1, next))
    }

    function levelText(weight) {
      const value = Number(weight)
      if (!Number.isFinite(value)) return '—'
      if (value >= 0.9) return '高'
      if (value >= 0.6) return '中'
      return '低'
    }

    /** 溯源的显示形态：一条画像从哪来，用户要能一眼看到而不只是信我们。 */
    function provenanceNote(item) {
      const prov = item?.provenance
      if (prov === null || prov === undefined) return ''
      const who = prov.kind === 'model' ? '模型提炼' : '你亲口说的'
      const when = typeof prov.at === 'string' && prov.at.length > 0 ? ` ${relTime(prov.at)}` : ''
      return ` · ${who}${when}`
    }

    function excerptOf(item) {
      const snippet = item?.provenance?.excerpt
      return typeof snippet === 'string' && snippet.length > 0 ? `原话：${snippet}` : undefined
    }

    function relTime(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      const then = Date.parse(value)
      if (!Number.isFinite(then)) return value
      const diff = Date.now() - then
      if (diff < 0) return '刚刚'
      const min = Math.floor(diff / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return `${min} 分钟前`
      const hour = Math.floor(min / 60)
      if (hour < 24) return `${hour} 小时前`
      const day = Math.floor(hour / 24)
      if (day < 30) return `${day} 天前`
      return value.slice(0, 10)
    }

    // ---------------------------------------------------------------- 概览

    function OverviewTab({ data, run, busy }) {
      const stats = data.stats ?? {}
      const cfg = data.settings ?? {}
      const dims = Array.isArray(data.dimensions) ? data.dimensions : []
      const dimCounts = stats.dimCounts ?? {}
      const items = Array.isArray(data.items) ? data.items : []
      const countedDims = dims
        .map((dim) => {
          const counted = dimCounts[dim.id] ?? {}
          return { id: dim.id, label: dim.label, total: (counted.declared ?? 0) + (counted.observed ?? 0) }
        })
        .filter((dim) => dim.total > 0)
        .sort((a, b) => b.total - a.total)
      const maxDim = Math.max(1, ...countedDims.map((dim) => dim.total))
      // 优先级就直接用权重折算成三档人话，不再把 0.45 这种内部数值摆给用户看。
      const levelOf = levelText
      const levels = ['高', '中', '低'].map((label) => ({ label, n: items.filter((item) => levelOf(item.weight) === label).length }))
      const maxLevel = Math.max(1, ...levels.map((level) => level.n))
      const drift = data.drift ?? {}
      const merged = Math.max(0, Number(stats.declared ?? 0) - Number(stats.items ?? 0))
      const nothing = items.length === 0

      const strategyRow = (label, value, key) => h('div', { key, style: styles.strategyRow },
        h('span', { style: styles.strategyLabel }, label),
        h('span', { style: styles.strategyValue }, value))

      return h('div', { style: styles.wrap },
        h('div', { style: styles.metrics },
          h(Metric, { label: '画像条目', value: String(stats.items ?? 0), hint: merged > 0 ? `${merged} 条判为同义 · 已合并` : `其中核心 ${stats.core ?? 0} 条`, tone: 'brand' }),
          h(Metric, { label: '你确认过的', value: String(stats.declared ?? 0), hint: stats.modelFacts ? `含模型提炼 ${stats.modelFacts} 条` : '全部由你确认' }),
          h(Metric, { label: '待你确认', value: String(stats.pending ?? 0), hint: (stats.pending ?? 0) > 0 ? '在「待审」里过一遍' : '没有新候选', tone: (stats.pending ?? 0) > 0 ? 'warn' : undefined }),
          h(Metric, { label: '上次更新', value: relTime(data.profile?.builtAt), hint: data.profile?.builtAt === null ? '还没有生成过' : undefined }),
        ),
        drift?.stale === true
          ? h('div', { style: styles.banner },
            h('span', { style: styles.bannerDot }),
            h('span', { style: { flex: 1 } }, '画像里还有新条目没并进来，更新一次就好。'),
            h(Btn, { onClick: () => run({ action: 'build' }), disabled: busy, mini: true }, '立即更新'))
          : null,
        nothing
          ? h(Section, { title: '画像还是空的' },
            h('div', { style: styles.note },
              '还没有可以依据的条目。三种方式让它长起来：在「条目」页手动记一条；聊几轮后由插件自动提炼（低置信的先进「待审」）；或在「备份与重置」里导入历史备份。'))
          : null,
        countedDims.length === 0
          ? null
          : h(Section, { title: '画像分布', extra: h('span', { style: styles.meta }, `${countedDims.length} 个大类有条目`) },
            countedDims.map((dim) => h('div', { key: dim.id, style: { ...styles.dimRow, gridTemplateColumns: '1.1fr 2fr 46px' } },
              h('span', { style: { fontSize: '12.5px' } }, dim.label),
              h(Bar, { ratio: dim.total / maxDim }),
              h('span', { style: { ...styles.meta, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, `${dim.total}`)))),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '14px' } },
          h(Section, { title: '优先级分布', extra: nothing ? null : h('span', { style: styles.meta }, '越靠前越先被采用') },
            levels.every((level) => level.n === 0)
              ? h('div', { style: styles.empty }, '还没有条目，暂时分布不出高低。')
              : levels.map((level) => h('div', { key: level.label, style: { ...styles.dimRow, gridTemplateColumns: '34px 1fr 26px' } },
                h('span', { style: styles.meta }, level.label),
                h(Bar, { ratio: level.n / maxLevel, tone: level.label === '低' ? 'warn' : undefined }),
                h('span', { style: { ...styles.meta, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, String(level.n))))),
          h(Section, { title: '当前策略' },
            strategyRow('每次任务前', cfg.enabled === false ? '不自动参考' : cfg.inject?.mode === 'on-request' ? '被要求时才参考' : '自动参考画像', 'p1'),
            strategyRow('个性化需求', cfg.inject?.priorityOnPersonalize === false ? '只当背景参考' : '以「个性化首选」为主要依据', 'p2'),
            strategyRow('画像更新', cfg.build?.autoBuild === false ? '手动更新' : '聊完自动更新', 'p3'),
            strategyRow('新偏好', cfg.extract?.enabled === false ? '只记你说过的' : '自动整理，低置信的先问你', 'p4'),
            strategyRow('重复条目', cfg.build?.dedupe === false ? '不合并' : '自动合并同义', 'p5'),
            strategyRow('隐私', cfg.capture?.turnText === false ? '不读正文' : '正文只进模型、不落盘', 'p6')),
        )
      )
    }

    // ---------------------------------------------------------------- 条目

    function ItemEditor({ item, dimensions, onSave, onCancel, busy }) {
      const [dim, setDim] = React.useState(item.dim)
      const [text, setText] = React.useState(item.text)
      const [key, setKey] = React.useState(item.key ?? '')
      const [core, setCore] = React.useState(item.core === true)
      const [weight, setWeight] = React.useState(String(Number(item.weight ?? 0.6)))
      return h('tr', null,
        h('td', { style: styles.td, colSpan: 5 },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: styles.formRow },
              h('select', { style: styles.select, value: dim, onChange: (event) => setDim(event.target.value) },
                dimensions.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
              h('input', { style: { ...styles.input, flex: 1 }, value: key, placeholder: 'key（可留空）', onChange: (event) => setKey(event.target.value) }),
              h('label', { style: { ...styles.meta, display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' } },
                '权重',
                h('input', {
                  style: { ...styles.input, width: '64px' },
                  type: 'number',
                  min: '0.1',
                  max: '1',
                  step: '0.05',
                  value: weight,
                  onChange: (event) => setWeight(event.target.value),
                })),
              h('label', { style: styles.meta },
                h('input', { type: 'checkbox', checked: core, onChange: (event) => setCore(event.target.checked), style: { marginRight: '4px' } }),
                '核心')),
            h('input', { style: styles.input, value: text, onChange: (event) => setText(event.target.value) }),
            h('div', { style: styles.formRow },
              h('button', {
                style: busy ? { ...styles.button, ...styles.buttonPrimary, ...styles.busy } : { ...styles.button, ...styles.buttonPrimary },
                disabled: busy,
                onClick: () => {
                  const next = nextWeight(weight, 0)
                  onSave({ dim, fact: text, key, core, weight: next, confidence: next })
                },
              }, '保存'),
              h('button', { style: styles.button, onClick: onCancel }, '取消'))))
      )
    }

    function ItemsTab({ data, run, busy, notify }) {
      /** 权重加减：直接写回该条的 confidence（declared 条目的权重就是它）。 */
      const bump = (item, delta) => {
        const next = nextWeight(item.weight, delta)
        // confidence 是老 action 认的字段，weight 是新字段：两个都发，换不换宿主都能用。
        return run({ action: 'edit', id: item.id, weight: next, confidence: next })
      }
      const items = Array.isArray(data.items) ? data.items : []
      const dimensions = Array.isArray(data.dimensions) ? data.dimensions : []
      const [query, setQuery] = React.useState('')
      const [dimFilter, setDimFilter] = React.useState('')
      const [sortKey, setSortKey] = React.useState('weight')
      const [editing, setEditing] = React.useState('')
      const [picked, setPicked] = React.useState({})
      const [armed, setArmed] = React.useState('')
      const [bulkArmed, setBulkArmed] = React.useState(false)

      const needle = query.trim().toLowerCase()
      const shown = items
        .filter((item) => (dimFilter === '' ? true : item.dim === dimFilter))
        .filter((item) => (needle === '' ? true : `${item.text} ${item.key ?? ''} ${item.dimLabel ?? ''}`.toLowerCase().includes(needle)))
      if (sortKey === 'time') shown.sort((a, b) => (String(a.lastSeen) < String(b.lastSeen) ? 1 : -1))
      else if (sortKey === 'dim') shown.sort((a, b) => (String(a.dimLabel) < String(b.dimLabel) ? -1 : 1))
      else shown.sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))

      const pickedIds = Object.keys(picked).filter((id) => picked[id] === true)
      const allPicked = shown.length > 0 && shown.every((item) => picked[item.id] === true)

      const toggle = (id) => setPicked((prev) => ({ ...prev, [id]: prev[id] !== true }))
      const dangerouslyArmed = (id) => armed === id

      return h('div', { style: styles.wrap },
        h('div', { style: styles.toolbar },
          h('input', { style: { ...styles.input, flex: '1 1 220px' }, placeholder: '搜索内容 / key / 维度…', value: query, onChange: (event) => setQuery(event.target.value) }),
          h('select', { style: styles.select, value: dimFilter, onChange: (event) => setDimFilter(event.target.value) },
            h('option', { value: '' }, '全部维度'),
            dimensions.map((dim) => h('option', { key: dim.id, value: dim.id }, dim.label))),
          h('select', { style: styles.select, value: sortKey, onChange: (event) => setSortKey(event.target.value) },
            h('option', { value: 'weight' }, '按权重'),
            h('option', { value: 'time' }, '按时间'),
            h('option', { value: 'dim' }, '按维度')),
          h('span', { style: styles.meta }, `${shown.length} / ${items.length} 条`)),
        pickedIds.length === 0 ? null : h('div', { style: { ...styles.notice, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', null, `已选 ${pickedIds.length} 条`),
          h('button', {
            style: styles.button,
            disabled: busy,
            onClick: async () => {
              for (const id of pickedIds) await run({ action: 'edit', id, core: true }, { silent: true })
              setPicked({})
            },
          }, '设为核心'),
          // 删除不可逆：先变成「确认删除 N 条」，5 秒内再点一次才真的执行。
          h('button', {
            style: { ...styles.button, ...styles.buttonDanger, ...(bulkArmed ? { background: T.layer2, fontWeight: 600 } : {}) },
            disabled: busy,
            onClick: async () => {
              if (bulkArmed !== true) {
                setBulkArmed(true)
                setTimeout(() => setBulkArmed(false), 5000)
                return
              }
              const total = pickedIds.length
              setBulkArmed(false)
              for (const id of pickedIds) await run({ action: 'forget', id }, { silent: true })
              setPicked({})
              if (typeof notify === 'function') notify(`已删除 ${total} 条。删错了也不要紧：到「备份与重置」→「恢复点」可整批还原。`)
            },
          }, bulkArmed === true ? `确认删除 ${pickedIds.length} 条` : '批量删除'),
          h('button', { style: styles.button, onClick: () => setPicked({}) }, '取消选择')),
        shown.length === 0
          ? h('div', { style: styles.empty }, items.length === 0 ? '画像还是空的：到「新增」表单记一条，或让插件在轮末自动提炼。' : '没有匹配的条目')
          : h('table', { style: styles.table },
            h('thead', null, h('tr', null,
              h('th', { style: styles.th },
                h('input', {
                  type: 'checkbox',
                  checked: allPicked,
                  onChange: (event) => {
                    const next = {}
                    if (event.target.checked) for (const item of shown) next[item.id] = true
                    setPicked(next)
                  },
                })),
              h('th', { style: { ...styles.th, width: '84px' } }, '维度'),
              h('th', { style: styles.th }, '内容 / 标记'),
              h('th', { style: { ...styles.thRight, width: '72px' } }, '权重'),
              h('th', { style: { ...styles.thRight, width: '138px' } }, '操作'))),
            h('tbody', null, shown.map((item) => editing === item.id
              ? h(ItemEditor, {
                key: item.id,
                item,
                dimensions,
                busy,
                onCancel: () => setEditing(''),
                onSave: async (patch) => {
                  await run({ action: 'edit', id: item.id, ...patch })
                  setEditing('')
                },
              })
              : h('tr', { key: item.id },
                h('td', { style: styles.td },
                  h('input', { type: 'checkbox', checked: picked[item.id] === true, onChange: () => toggle(item.id) })),
                h('td', { style: { ...styles.td, width: '84px', whiteSpace: 'nowrap' } },
                  h('span', { style: { fontSize: '12px', color: T.label2 } }, item.dimLabel ?? item.dim),
                  item.scope !== undefined && item.scope !== 'global' ? h(Badge, { text: `作用域 ${item.scopeId ?? item.scope}` }) : null),
                h('td', { style: styles.td },
                  h('span', { title: excerptOf(item) }, item.text),
                  item.core ? h(Badge, { text: '核心', tone: 'core' }) : null,
                  item.frozen ? h(Badge, { text: '未决·冻结', tone: 'warn' }) : null,
                  item.kind === 'declared' ? h(Badge, { text: '已确认' }) : h(Badge, { text: '我的观察' }),
                  h('div', { style: styles.mono }, `更新于 ${relTime(item.lastSeen)}${provenanceNote(item)}`)),
                h('td', { style: styles.tdRight },
                  h('div', { style: styles.weightRow },
                    h('button', {
                      style: styles.step,
                      title: '降低权重',
                      disabled: busy || Number(item.weight ?? 0) <= 0.1,
                      onClick: () => bump(item, -0.1),
                    }, '－'),
                    h('span', { style: styles.meta }, levelText(item.weight)),
                    h('button', {
                      style: styles.step,
                      title: '提高权重',
                      disabled: busy || Number(item.weight ?? 0) >= 1,
                      onClick: () => bump(item, 0.1),
                    }, '＋')),
                  h('div', { style: { marginTop: '4px', minWidth: '56px' } }, h(Bar, { ratio: Number(item.weight ?? 0) }))),
                h('td', { style: styles.tdRight },
                  item.kind === 'declared'
                    ? h('span', { style: { ...styles.formRow, flexWrap: 'nowrap', justifyContent: 'flex-end' } },
                      h('button', { style: { ...styles.button, ...styles.buttonMini }, disabled: busy, onClick: () => setEditing(item.id) }, '编辑'),
                      h('button', {
                        style: { ...styles.button, ...styles.buttonMini },
                        disabled: busy,
                        onClick: () => run({ action: 'edit', id: item.id, core: !item.core }),
                      }, item.core ? '取消核心' : '设核心'),
                      h('button', {
                        style: dangerouslyArmed(item.id) ? { ...styles.button, ...styles.buttonMini, ...styles.buttonDanger } : { ...styles.button, ...styles.buttonMini },
                        disabled: busy,
                        onClick: () => {
                          if (dangerouslyArmed(item.id)) {
                            setArmed('')
                            run({ action: 'forget', id: item.id })
                          } else {
                            setArmed(item.id)
                            setTimeout(() => setArmed((prev) => (prev === item.id ? '' : prev)), 4000)
                          }
                        },
                      }, dangerouslyArmed(item.id) ? '确认删除' : '删除'))
                    : h('span', { style: styles.meta }, '自动采集')))
            )))
      )
    }

    // ---------------------------------------------------------------- 待审

    function PendingTab({ data, run, busy }) {
      const pending = Array.isArray(data.pending) ? data.pending : []
      if (pending.length === 0) return h('div', { style: styles.empty }, '没有待审候选。低置信度的提炼结果会先落到这里，等你确认。')
      return h('div', { style: styles.wrap },
        h('div', { style: styles.toolbar },
          h('span', { style: styles.meta }, `${pending.length} 条候选未计入画像`),
          h('button', { style: styles.button, disabled: busy, onClick: () => run({ action: 'review', accept: 'all' }) }, '全部接受'),
          h('button', { style: { ...styles.button, ...styles.buttonDanger }, disabled: busy, onClick: () => run({ action: 'review', reject: 'all' }) }, '全部丢弃')),
        h('table', { style: styles.table },
          h('thead', null, h('tr', null,
            h('th', { style: styles.th }, '维度'),
            h('th', { style: styles.th }, '内容'),
            h('th', { style: styles.thRight }, '置信'),
            h('th', { style: styles.thRight }, '操作'))),
          h('tbody', null, pending.map((row) => h('tr', { key: row.id },
            h('td', { style: styles.td }, row.dim),
            h('td', { style: styles.td },
              h('span', { title: excerptOf(row) }, row.fact),
              h('div', { style: styles.mono }, `${row.source === 'model' ? '模型提炼' : '手动记录'} · ${relTime(row.at)}${provenanceNote(row)}`)),
            h('td', { style: styles.tdRight }, String(row.confidence ?? 1)),
            h('td', { style: styles.tdRight }, h('span', { style: styles.formRow },
              h('button', { style: { ...styles.button, ...styles.buttonMini, ...styles.buttonPrimary }, disabled: busy, onClick: () => run({ action: 'review', accept: row.id }) }, '接受'),
              h('button', { style: { ...styles.button, ...styles.buttonMini }, disabled: busy, onClick: () => run({ action: 'review', reject: row.id }) }, '丢弃')))))))
      )
    }

    // ---------------------------------------------------------------- 冲突与历史

    function ConflictsTab({ data }) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : []
      const history = Array.isArray(data.history) ? data.history : []
      const label = (status) => status === 'merged' ? '判为同义，已合并' : status === 'resolved' ? '新值覆盖旧值' : status === 'frozen' ? '已冻结，不选边' : '未决'
      return h('div', { style: styles.wrap },
        h(Section, { title: `冲突判定 · ${conflicts.length} 条`, extra: h('span', { style: styles.note }, '同义合并按相似度自动判；冲突按「新值覆盖旧值」，旧值留档') },
          conflicts.length === 0 ? h('div', { style: styles.empty }, '没有冲突记录') : h('table', { style: styles.table },
            h('thead', null, h('tr', null,
              h('th', { style: styles.th }, '维度 / key'),
              h('th', { style: styles.th }, '双方'),
              h('th', { style: styles.th }, '判定'))),
            h('tbody', null, conflicts.map((row, index) => h('tr', { key: `${row.key}-${index}` },
              h('td', { style: styles.td }, h('div', { style: styles.mono }, `${row.dim} / ${row.key ?? '—'}`)),
              h('td', { style: styles.td },
                h('div', null, `A：${row.from?.text ?? ''}`),
                h('div', { style: { marginTop: '3px' } }, `B：${row.to?.text ?? ''}`)),
              h('td', { style: styles.td }, label(row.status), row.rule === undefined ? null : h('div', { style: styles.mono }, row.rule))))))),
        h(Section, { title: `历史留档 · ${history.length} 条`, extra: h('span', { style: styles.note }, '被覆盖或合并掉的原文都在这里，删除不可恢复') },
          history.length === 0 ? h('div', { style: styles.empty }, '没有历史条目') : h('div', null, history.map((row, index) => h('div', { key: `${row.id ?? index}`, style: styles.listRow },
            h('span', { style: styles.mono }, row.dimLabel ?? row.dim),
            h('span', { style: { flex: 1 } }, row.text),
            h('span', { style: styles.meta }, row.mergedAs === 'duplicate' ? '判为同义被合并' : '被新值覆盖'),
            h('span', { style: styles.meta }, relTime(row.lastSeen))))))
      )
    }

    // ---------------------------------------------------------------- 维度

    function DimsTab({ data, run, busy }) {
      const dims = Array.isArray(data.dimensions) ? data.dimensions : []
      const counts = data.stats?.dimCounts ?? {}
      const [newId, setNewId] = React.useState('')
      const [newLabel, setNewLabel] = React.useState('')
      const [armed, setArmed] = React.useState('')
      return h('div', { style: styles.wrap },
        h(Section, { title: '画像大类', extra: h('span', { style: styles.note }, '一类只回答一个问题；条目按「大类.细分」的 key 归档') },
          h('div', { style: styles.dimRow, gridTemplateColumns: '1.9fr 90px auto' },
            h('span', { style: styles.th }, '大类 / 收什么'),
            h('span', { style: styles.th }, '条目数'),
            h('span', { style: styles.th }, '操作')),
          dims.map((dim) => h('div', { key: dim.id, style: { ...styles.dimRow, gridTemplateColumns: '1.9fr 90px auto', alignItems: 'start' } },
            h('div', null,
              h('div', null, dim.label, h(Badge, { text: dim.id })),
              h('div', { style: styles.note }, dim.hint ?? '自定义大类')),
            h('span', { style: styles.meta }, String((counts[dim.id]?.declared ?? 0) + (counts[dim.id]?.observed ?? 0))),
            h('button', {
              style: armed === dim.id ? { ...styles.button, ...styles.buttonMini, ...styles.buttonDanger } : { ...styles.button, ...styles.buttonMini },
              disabled: busy,
              onClick: () => {
                if (armed === dim.id) {
                  setArmed('')
                  run({ action: 'dims', remove: true, id: dim.id })
                } else {
                  setArmed(dim.id)
                  setTimeout(() => setArmed((prev) => (prev === dim.id ? '' : prev)), 4000)
                }
              },
            }, armed === dim.id ? '确认删除' : '删除')))),
        h(Section, { title: '新增维度' },
          h('div', { style: styles.formRow },
            h('input', { style: { ...styles.input, flex: '1 1 140px' }, placeholder: 'id（小写英文，如 tooling）', value: newId, onChange: (event) => setNewId(event.target.value) }),
            h('input', { style: { ...styles.input, flex: '1 1 160px' }, placeholder: '中文名称', value: newLabel, onChange: (event) => setNewLabel(event.target.value) }),
            h('button', {
              style: { ...styles.button, ...styles.buttonPrimary },
              disabled: busy || newId.trim() === '' || newLabel.trim() === '',
              onClick: async () => {
                await run({ action: 'dims', add: true, id: newId.trim(), label: newLabel.trim() })
                setNewId('')
                setNewLabel('')
              },
            }, '添加')),
          h('div', { style: styles.note }, '删除维度不会删条目，只是这些条目不再显示在对应分栏里；要连条目一起清，用「数据」页的批量删除。'))
      )
    }

    // ---------------------------------------------------------------- 设置

    const SETTINGS_FORM = [
      { group: '画像怎么被使用', fields: [
        { path: 'enabled', label: '每次任务前自动参考画像', type: 'bool', hint: '关掉后任何任务都不会自动带上画像' },
        { path: 'inject.priorityOnPersonalize', label: '个性化需求时以画像为主要依据', type: 'bool', hint: '涉及风格、口味、默认选择、文案、推荐、界面时，画像不再只是背景，而是选方案的主要依据' },
        { path: 'inject.mode', label: '什么时候参考', type: 'select', options: ['always', 'on-request'], optionLabels: ['每轮都带（always）', '只在被要求时带（on-request）'] },
        { path: 'inject.maxChars', label: '最多带多少字', type: 'number', hint: '0 表示不设上限（条目质量靠有效性闸门把关，不靠截断）' },
        { path: 'inject.topK', label: '最多带多少条', type: 'number', hint: '0 表示不设上限；填正数时只限制「背景参考」段' },
        { path: 'build.minEvidenceForPortrait', label: '至少多少条才启用', type: 'number', hint: '不足时不参考画像，避免拿一条样本当结论' },
      ] },
      { group: '说法冲突时', fields: [
        { path: 'conflicts.strategy', label: '同一件事有两种说法', type: 'select', options: ['newest', 'freeze'], optionLabels: ['以最新一次为准（newest）', '两条都留着，等你判断（freeze）'] },
        { path: 'build.dedupe', label: '自动合并重复条目', type: 'bool', hint: '意思相同只是措辞不同的，保留更确定的那条' },
      ] },
      { group: '自动整理', fields: [
        { path: 'extract.enabled', label: '聊完自动整理新偏好', type: 'bool', hint: '每轮结束把对话里能长期复用的信息提炼成条目' },
        { path: 'extract.everyTurns', label: '每几轮整理一次', type: 'number' },
        { path: 'extract.autoAcceptConfidence', label: '多确定才自动收录', type: 'number', hint: '0–1；低于这个值会先放进「待审」等你确认' },
      ] },
      { group: '更新与隐私', fields: [
        { path: 'inject.relevantOnly', label: '只带入和本轮相关的条目', type: 'bool', hint: '关掉则每次把整份画像都带进来（红线永远带入）' },
        { path: 'build.autoBuild', label: '画像随对话自动更新', type: 'bool', hint: '关掉后只在点「立即更新」时重算' },
        { path: 'capture.turnText', label: '允许读取对话正文来提炼', type: 'bool', hint: '正文只进模型、不落盘；关掉就只能靠你自己说过的内容' },
        { path: 'redaction.mode', label: '敏感信息处理', type: 'select', options: ['preset', 'patterns', 'unknown'], optionLabels: ['自动抹掉手机号·邮箱·证件号·密钥（preset）', '只用自定义规则（patterns）', '先别动（unknown）'] },
      ] },
      { group: '云端备份（WebDAV）', fields: [
        { path: 'backup.webdav.url', label: 'WebDAV 地址', type: 'text', hint: '例如 https://dav.example.com/remote.php/dav/files/me' },
        { path: 'backup.webdav.username', label: '账号', type: 'text' },
        { path: 'backup.webdav.passwordEnv', label: '密码所在的环境变量名', type: 'text', hint: '默认 DSH_PROFILE_WEBDAV_PASSWORD；密码本身不写进配置文件' },
        { path: 'backup.webdav.remoteDir', label: '远端目录', type: 'text', hint: '不存在会自动创建' },
        { path: 'backup.webdav.autoUploadOnBuild', label: '每次重建后自动上传', type: 'bool', hint: '默认关：网络写入不该由一次普通重建触发' },
      ] },
    ]

    function readPath(object, path) {
      let node = object
      for (const step of String(path).split('.')) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[step]
      }
      return node
    }

    function SettingsTab({ data, run, busy }) {
      const settings = data.settings ?? {}
      const [draft, setDraft] = React.useState({})
      const valueOf = (path) => (Object.prototype.hasOwnProperty.call(draft, path) ? draft[path] : readPath(settings, path))
      const setValue = (path, value) => setDraft((prev) => ({ ...prev, [path]: value }))
      const changed = Object.keys(draft).filter((path) => JSON.stringify(draft[path]) !== JSON.stringify(readPath(settings, path)))

      const control = (field) => {
        const value = valueOf(field.path)
        if (field.type === 'bool') {
          return h('input', {
            type: 'checkbox',
            checked: value !== false && value !== undefined,
            onChange: (event) => setValue(field.path, event.target.checked),
          })
        }
        if (field.type === 'select') {
          return h('select', { style: styles.select, value: String(value ?? ''), onChange: (event) => setValue(field.path, event.target.value) },
            field.options.map((option, index) => h('option', { key: option, value: option }, field.optionLabels?.[index] ?? option)))
        }
        if (field.type === 'number') {
          return h('input', {
            style: styles.input,
            type: 'number',
            value: value === undefined ? '' : String(value),
            onChange: (event) => setValue(field.path, event.target.value === '' ? '' : Number(event.target.value)),
          })
        }
        return h('input', { style: styles.input, value: value === undefined ? '' : String(value), onChange: (event) => setValue(field.path, event.target.value) })
      }

      return h('div', { style: styles.wrap },
        changed.length === 0
          ? h('div', { style: { ...styles.meta, fontSize: '11.5px' } }, '改动会先攒在这里，点「保存并重建」才写进 config.json。')
          : h('div', { style: styles.saveBar },
            h('span', { style: { fontSize: '12px', color: T.label1, fontWeight: 500 } }, `${changed.length} 项待保存`),
            h('span', { style: styles.spacer }),
            h('button', {
              style: busy ? { ...styles.button, ...styles.buttonPrimary, ...styles.busy } : { ...styles.button, ...styles.buttonPrimary },
              disabled: busy,
              onClick: async () => {
                const entries = {}
                for (const path of changed) entries[path] = draft[path]
                const result = await run({ action: 'settings', entries }, { silent: true })
                if (result?.ok !== false) setDraft({})
              },
            }, busy ? '保存中…' : '保存并重建'),
            h('button', { style: styles.button, disabled: busy, onClick: () => setDraft({}) }, '放弃修改')),
        SETTINGS_FORM.map((group) => h(Section, { key: group.group, title: group.group },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '14px' } }, group.fields.map((field) => h(Field, {
            key: field.path,
            label: field.label,
            hint: field.hint ?? '',
          }, control(field)))))),
        h('div', { style: styles.note }, '设置写进 config.json，保存后会立刻重建画像，所以注入与面板同时生效。'))
    }

    // ---------------------------------------------------------- 备份与重置

    function DataTab({ data, run, busy }) {
      const [out, setOut] = React.useState('')
      const [json, setJson] = React.useState('')
      const [armed, setArmed] = React.useState(false)
      const [snapArmed, setSnapArmed] = React.useState('')
      const [showAllSnaps, setShowAllSnaps] = React.useState(false)
      const [davDir, setDavDir] = React.useState('')
    const [encBackup, setEncBackup] = React.useState(false)
      const snapshots = Array.isArray(data.snapshots) ? data.snapshots : []
      const visibleSnaps = showAllSnaps ? snapshots : snapshots.slice(0, 5)
      return h('div', { style: styles.wrap },
        h(Section, {
          title: '恢复点',
          extra: h('span', { style: styles.note }, '每次删除前自动留一份，最多 20 份'),
        },
          snapshots.length === 0
            ? h('div', { style: styles.empty }, '还没有恢复点。删过条目之后这里会出现可回退的版本。')
            : h('div', null, visibleSnaps.map((snap) => {
              const armedNow = snapArmed === snap.name
              const tagText = snap.tag === 'restore' ? '恢复前' : snap.tag === 'forget' ? '删除前' : snap.tag
              return h('div', { key: snap.name, style: styles.snapRow },
                h('div', null,
                  h('div', { style: { fontSize: '12px' } }, `${tagText} · ${snap.count} 条`),
                  h('div', { style: styles.mono }, snap.name)),
                h(Btn, {
                  mini: true,
                  tone: armedNow ? 'danger' : undefined,
                  disabled: busy,
                  onClick: async () => {
                    if (!armedNow) {
                      setSnapArmed(snap.name)
                      setTimeout(() => setSnapArmed(''), 5000)
                      return
                    }
                    setSnapArmed('')
                    await run({ action: 'restore', name: snap.name })
                  },
                }, armedNow ? '再点一次覆盖当前' : '恢复'),
                h('span', { style: styles.note }, armedNow ? '会覆盖当前条目' : ''))
            })),
            snapshots.length > 5
              ? h('div', { style: { marginTop: '10px' } },
                h(Btn, { mini: true, onClick: () => setShowAllSnaps((prev) => prev !== true) },
                  showAllSnaps ? '收起' : `展开全部 ${snapshots.length} 份`))
              : null),
        h(Section, { title: '导出备份', extra: h('span', { style: styles.note }, '带走一份完整副本，换电脑或重装都能导回来') },
          h('div', { style: styles.formRow },
            h('input', { style: { ...styles.input, flex: 1 }, placeholder: '存到哪个文件夹（留空自动按时间命名）', value: out, onChange: (event) => setOut(event.target.value) }),
            h(Btn, { disabled: busy, onClick: () => run({ action: 'export', out }) }, '导出')),
          h('div', { style: styles.note }, '导出的是画像条目、待审候选、变更记录与设置。')),
        h(Section, { title: '体检 · 脱敏 · 云端备份', extra: h('span', { style: styles.note }, '质量与隐私的日常维护') },
          h('div', { style: styles.formRow },
            h(Btn, { mini: true, disabled: busy, onClick: () => run({ action: 'validate' }) }, '体检条目'),
            h(Btn, { mini: true, disabled: busy, onClick: () => run({ action: 'redact' }) }, '扫描敏感信息'),
            h(Btn, { mini: true, tone: 'danger', disabled: busy, onClick: () => run({ action: 'redact', apply: true }) }, '脱敏并写回')),
          h('div', { style: styles.note }, '体检只报告不改数据：查结构是否被破坏、维度是否还有效、置信度是否越界、以及哪些条目看起来像「本次任务的细节」。脱敏按手机号 / 邮箱 / 证件号 / 密钥四类预设匹配，写回前会自动留一份恢复点。'),
          h('div', { style: { marginTop: '14px' } },
            h('div', { style: styles.formRow },
              h('input', {
                style: { ...styles.input, flex: 1 },
                placeholder: '本地导出目录（留空则不导出；WebDAV 需先在「设置」里填地址）',
                value: davDir,
                onChange: (event) => setDavDir(event.target.value),
              }),
              h(Btn, { mini: true, disabled: busy || davDir.trim() === '', onClick: () => run({ action: 'backup', mode: 'out', dir: davDir.trim(), encrypt: encBackup }) }, encBackup ? '加密导出到本地' : '导出到本地'),
              h(Btn, { mini: true, disabled: busy, onClick: () => run({ action: 'backup', mode: 'upload' }) }, '上传到 WebDAV'),
              h(Btn, { mini: true, disabled: busy, onClick: () => run({ action: 'backup', mode: 'list' }) }, '看远端备份')),
            h('label', { style: styles.check },
              h('input', { type: 'checkbox', checked: encBackup, onChange: (event) => setEncBackup(event.target.checked) }),
              '导出时加密（口令取 DSH_PROFILE_PASSPHRASE / secrets.json；上传默认已加密）'),
            h('div', { style: styles.note }, 'WebDAV 的地址与账号在「设置 → 云端备份」里填；密码建议放环境变量 DSH_PROFILE_WEBDAV_PASSWORD，不写进配置文件。加密包是 AES-256-GCM，回灌前先 `profile unseal --file <包>`。'))),
        h(Section, { title: '批量导入', extra: h('span', { style: styles.note }, '接受 [{"dim","fact","key"}] 或 {"items":[…]}]，也认一行一条的 JSONL') },
          h('textarea', { style: styles.textarea, value: json, placeholder: '[{ "dim": "taste", "fact": "用户偏好结论先行", "confidence": 0.9 }]', onChange: (event) => setJson(event.target.value) }),
          h('div', { style: styles.formRow },
            h(Btn, {
              disabled: busy || json.trim() === '',
              onClick: async () => {
                let parsed = null
                try {
                  parsed = JSON.parse(json)
                } catch (error) {
                  await run({ action: '__invalid', message: String(error?.message ?? error) })
                  return
                }
                const items = Array.isArray(parsed) ? parsed : parsed?.items
                if (!Array.isArray(items)) return
                const result = await run({ action: 'importText', items })
                if (result?.ok !== false) setJson('')
              },
            }, '导入'),
            h('span', { style: styles.note }, '导入的条目与手动记录等价，可直接编辑与删除。'))),
        h(Section, { title: '重置', extra: h('span', { style: styles.note }, '归档到 archive/<时间戳> 后清空，可手工恢复') },
          h('div', { style: styles.dangerZone },
            h('div', { style: styles.formRow },
              h(Btn, {
                tone: 'danger',
                disabled: busy,
                onClick: async () => {
                  if (!armed) {
                    setArmed(true)
                    setTimeout(() => setArmed(false), 5000)
                    return
                  }
                  setArmed(false)
                  await run({ action: 'reset', confirm: true })
                },
              }, armed ? '再点一次确认重置' : '重置全部数据'),
              h('span', { style: styles.note }, armed ? '5 秒内再点一次才执行' : '会先归档，不会直接丢弃'))))
      )
    }

    // ---------------------------------------------------------------- 外壳

    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'items', label: '条目' },
      { id: 'pending', label: '待审' },
      { id: 'conflicts', label: '冲突与历史' },
      { id: 'dims', label: '维度' },
      { id: 'settings', label: '设置' },
      { id: 'data', label: '备份与重置' },
    ]

    function ProfileSection() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' })
      const [tab, setTab] = React.useState('overview')
      const [notice, setNotice] = React.useState('')
      const [acting, setActing] = React.useState(false)

      const load = React.useCallback(async (silent) => {
        setState((prev) => ({ phase: prev.data === null ? 'loading' : silent ? 'refreshing' : 'loading', data: prev.data, error: '' }))
        try {
          const data = await fetchPanel()
          setState({ phase: 'ready', data, error: '' })
        } catch (error) {
          setState({ phase: 'error', data: null, error: String(error?.message ?? error) })
        }
      }, [])

      React.useEffect(() => {
        load(false)
      }, [load])

      const run = React.useCallback(async (payload, options) => {
        // 内部用 __invalid 把「前端解析失败」也变成一次可见的提示，而不是静默吞掉。
        if (payload?.action === '__invalid') {
          setNotice(`JSON 不合法：${payload.message ?? ''}`)
          return { ok: false }
        }
        setActing(true)
        setNotice('')
        try {
          const result = await postAction(payload)
          if (options?.silent !== true) setNotice(result?.output ?? '已完成')
          await load(true)
          return result ?? { ok: true }
        } catch (error) {
          setNotice(`失败：${String(error?.message ?? error)}`)
          return { ok: false }
        } finally {
          setActing(false)
        }
      }, [load])

      // 提示 8 秒自动收走：动作成功的回执不需要一直占着版面。
      React.useEffect(() => {
        if (notice === '') return undefined
        const timer = setTimeout(() => setNotice(''), 8000)
        return () => clearTimeout(timer)
      }, [notice])

      if (state.phase === 'loading' && state.data === null) {
        return h('div', { style: styles.wrap },
          h('div', { style: { ...styles.skeleton, width: '38%', height: '18px' } }),
          h('div', { style: { ...styles.skeleton, width: '72%' } }),
          h('div', { style: { ...styles.skeleton, width: '54%' } }),
          h('div', { style: { ...styles.skeleton, width: '64%' } }))
      }
      if (state.phase === 'error') {
        return h('div', { style: styles.wrap },
          h('div', { style: { ...styles.card, borderColor: T.warn } },
            h('div', { style: { ...styles.h2, color: T.warn } }, '读不到画像数据'),
            h('div', { style: styles.note }, state.error),
            h('div', { style: { marginTop: '8px' } },
              h(Btn, { tone: 'primary', onClick: () => load(false) }, '重试'))))
      }

      const data = state.data ?? {}
      const profile = data.profile ?? { status: 'missing' }
      const stats = data.stats ?? {}
      const busy = acting
      const counts = { pending: stats.pending ?? 0, items: stats.items ?? 0, conflicts: (data.conflicts ?? []).length, dims: (data.dimensions ?? []).length }
      const noticeTone = notice.startsWith('失败') || notice.startsWith('JSON') ? T.error : T.success

      const header = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '14px', borderBottom: `1px solid ${T.border1}` } },
        h('div', { style: styles.head },
          h('h2', { style: styles.title }, '用户画像'),
          h(StatusPill, { profile, items: stats.items ?? 0 }),
          h('span', { style: styles.spacer }),
          h(Btn, { mini: true, disabled: busy, onClick: () => load(true) }, state.phase === 'refreshing' ? '刷新中…' : '刷新'),
          h(Btn, { mini: true, tone: 'primary', disabled: busy, onClick: () => run({ action: 'build' }) }, '立即更新')),
        h('div', { style: { ...styles.meta, fontSize: '11.5px' } },
          `v${profile.revision ?? 0} · ${stats.declared ?? 0} 条已确认 · 按优先级排列`))

      const tabBar = h('div', { style: styles.stickyTabs }, TABS.map((item) => {
        const count = item.id === 'pending' ? counts.pending : item.id === 'conflicts' ? counts.conflicts : item.id === 'dims' ? counts.dims : 0
        return h('button', {
          key: item.id,
          style: tab === item.id ? { ...styles.tab, ...styles.tabActive } : styles.tab,
          onClick: () => setTab(item.id),
        }, item.label, count > 0 ? h('span', { style: styles.tabCount }, String(count)) : null)
      }))

      const body = tab === 'overview' ? h(OverviewTab, { data, run, busy })
        : tab === 'items' ? h(ItemsTab, { data, run, busy, notify: setNotice })
          : tab === 'pending' ? h(PendingTab, { data, run, busy })
            : tab === 'conflicts' ? h(ConflictsTab, { data })
              : tab === 'dims' ? h(DimsTab, { data, run, busy })
                : tab === 'settings' ? h(SettingsTab, { data, run, busy })
                  : h(DataTab, { data, run, busy })

      const noticeLine = notice === '' ? null : h('div', {
        style: { ...styles.notice, borderLeft: `2px solid ${noticeTone}`, display: 'flex', gap: '8px', alignItems: 'flex-start' },
      },
      h('span', { style: { flex: 1 } }, notice),
      h('button', {
        style: { border: 'none', background: 'transparent', color: T.label3, cursor: 'pointer', fontSize: '12px', lineHeight: 1.2 },
        onClick: () => setNotice(''),
        title: '关闭',
      }, '×'))

      // 数据完整性告警（坏行被隔离、配置文件损坏后重建）：必须显式说出来，
      // 悄悄自愈比报错更危险——用户会以为数据一直好好的。
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      const warningsLine = warnings.length === 0 ? null : h('div', {
        style: { ...styles.notice, borderLeft: `2px solid ${T.warn}`, color: T.label1 },
      }, `数据提示：${warnings.join('；')}`)

      return h('div', { style: styles.wrap }, header, warningsLine, noticeLine, tabBar, body)
    }

    // 不声明硬依赖：缺 slots 的宿主也应当能加载本 bundle（apply 内部再做能力判断）。
    const inject = []

    /**
     * settings.section 由 @deepseek-ai/dsh-client-ui-settings 声明；本插件只贡献一个页签。
     * 老宿主的 client 端可能没有 slots 服务（或没有这个槽位）：这时静默退出，
     * 绝不能在 apply 里抛——抛出去会让整个设置页挂掉，而用户只是少了一个页签。
     */
    function apply(ctx) {
      try {
        if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') return
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'user-profile',
          order: 55,
          label: () => '用户画像',
        }, ProfileSection))
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-user-profile] 设置页注册失败（宿主可能没有 settings.section 槽位）：', error?.message ?? error)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
