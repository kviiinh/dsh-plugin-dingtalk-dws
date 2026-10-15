/**
 * browser half：钉钉连接器的界面。
 *
 * 只挂一个座位，是插件**自己**的：
 *
 *   `plugins.row.config` —— 插件详情页里本插件那一行，键为 `<包名>#<行 id>`，
 *   所以从「设置 → 插件 → 钉钉连接器 → 点开那一行」就能看到状态与操作。
 *
 * 数据都来自 Host 的只读路由（信任围栏在 Host 侧），
 * 这里不做任何直连钉钉的请求，也不缓存凭证。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-dingtalk-dws',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 侧路由前缀，与 index.js 的 ROUTE_PREFIX 保持一致。 */
    const BASE = '/dingtalk-dws'
    /** 状态轮询间隔；Host 侧还有 10s 缓存兜底，不会真的每次都起进程。 */
    const POLL_MS = 15000
    /**
     * 首次挂载后不自动强刷。
     *
     * `auth status` 会刷新 token，而 refresh_token 是单设备独占、用后轮转的，
     * 所以「真正刷新」必须由用户点按钮触发。
     */
    const AUTO_FORCE = false
    /** 本插件在 profile 里的行 id；`plugins.row.config` 的键必须精确匹配它。 */
    const ROW_KEY = 'dsh-plugin-dingtalk-dws#dingtalk-dws'

    /**
     * 调一条 Host 路由并解析 JSON。
     * @param {string} path 路由路径（含查询串）。
     * @param {RequestInit} [init] fetch 选项。
     * @returns {Promise<any>} 解析后的响应体。
     */
    async function call(path, init) {
      const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init })
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (!response.ok) {
        const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', fontSize: 13 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { color: 'var(--dsw-alias-label-secondary)', minWidth: 72 },
      value: { color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' },
      dot: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
      },
      buttonPrimary: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      buttonDanger: { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.6 },
      pre: {
        margin: 0,
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--dsw-alias-label-secondary)',
        maxHeight: 220,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 8,
        padding: 10,
      },
      link: { color: 'var(--dsw-alias-brand-primary)', wordBreak: 'break-all' },
      title: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
    }

    /** 状态 → 主题色。 */
    function stateColor(state) {
      if (state === 'connected') return 'var(--dsw-alias-state-success-primary)'
      if (state === 'expired') return 'var(--dsw-alias-state-warn-primary)'
      if (state === 'cli_missing' || state === 'cli_error' || state === 'error') return 'var(--dsw-alias-state-error-primary)'
      if (state === 'unauthenticated') return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-idle-primary)'
    }

    /** 状态 → 中文标签。 */
    function stateLabel(state) {
      if (state === 'connected') return '已连接'
      if (state === 'expired') return '登录态需刷新'
      if (state === 'unauthenticated') return '未登录'
      if (state === 'cli_missing') return '找不到 dws'
      if (state === 'cli_error') return 'dws 报错'
      if (state === 'error') return '出错'
      if (!state) return '检查中…'
      return state
    }

    /** 短时间格式。 */
    function formatTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** 一行「标签 + 值」。 */
    function Field(props) {
      if (!props.value && props.value !== 0) return null
      return h('div', { style: S.row },
        h('span', { style: S.label }, props.label),
        h('span', { style: S.value }, props.value))
    }

    /**
     * 设置页主体。
     * @param {object} props 设置页传入的属性（本面板不依赖具体字段）。
     * @returns {import('react').ReactElement} 面板。
     */
    function DingtalkPanel(props) {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [loginUrl, setLoginUrl] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [doctor, setDoctor] = React.useState('')

      const load = React.useCallback(async (fresh) => {
        try {
          const payload = await call(`/status${fresh ? '?fresh=1' : ''}`)
          setStatus(payload)
          setError('')
          if (payload && payload.login && payload.login.url) setLoginUrl(payload.login.url)
          return payload
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
          return null
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive) return
          const payload = await load(AUTO_FORCE)
          // 登录完成后停掉链接提示。
          if (alive && payload && payload.state === 'connected') { setLoginUrl(''); setNotice('') }
        }
        void tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const login = async () => {
        setBusy('login'); setNotice(''); setError('')
        try {
          const payload = await call('/login', { method: 'POST' })
          if (payload && payload.url) {
            setLoginUrl(payload.url)
            setNotice(payload.note || '请在浏览器打开下面的链接完成授权')
          } else {
            setNotice((payload && payload.note) || '登录已启动，请稍后刷新状态')
          }
          await load(false)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const logout = async () => {
        if (busy) return
        const who = status && status.userName ? `${status.userName}（${status.corpName || '未知组织'}）` : '当前钉钉账号'
        // 退出登录只在本地清除登录态，但会让所有依赖钉钉的功能立刻不可用，所以必须确认。
        if (!window.confirm(`确认退出登录？这将清除本机的钉钉登录态（${who}）。\n\n之后所有钉钉工具都会失败，需要重新登录。`)) return
        setBusy('logout'); setNotice(''); setError('')
        try {
          const payload = await call('/logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true }),
          })
          setNotice((payload && payload.message) || '已退出登录')
          if (payload && payload.status) setStatus(payload.status)
          setLoginUrl('')
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const refresh = async () => {
        setBusy('refresh'); setNotice(''); setError('')
        try {
          await load(true)
          setNotice('已刷新连接状态')
        } finally {
          setBusy('')
        }
      }

      const runDoctor = async () => {
        setBusy('doctor'); setNotice(''); setError(''); setDoctor('')
        try {
          const payload = await call('/cli-status')
          setDoctor((payload && payload.text) || '(无输出)')
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const state = status && status.state
      const connected = state === 'connected'
      const button = (extra, disabled) => ({ ...S.button, ...extra, ...(disabled ? S.buttonDisabled : {}) })

      return h('div', { style: S.page },
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: { ...S.dot, background: stateColor(state) } }),
            h('span', { style: S.title }, `钉钉：${stateLabel(state)}`),
            h('span', { style: S.note }, status && status.cached ? '（缓存）' : '')),

          h(Field, { label: '组织', value: status && status.corpName }),
          h(Field, { label: '账号', value: status && status.userName }),
          h(Field, { label: 'Profile', value: status && status.profile }),
          h(Field, { label: 'CLI', value: status && status.binary }),
          h(Field, { label: '检查于', value: status ? formatTime(status.checkedAt) : '' }),

          status && status.message ? h('div', { style: S.note }, status.message) : null,
          status && status.hint ? h('div', { style: S.note }, status.hint) : null,
          error ? h('div', { style: S.error }, error) : null,
          notice ? h('div', { style: S.note }, notice) : null,

          h('div', { style: S.row },
            h('button', {
              style: button(S.buttonPrimary, Boolean(busy) || connected),
              disabled: Boolean(busy) || connected,
              onClick: login,
              title: connected ? '当前已连接，需先退出登录才能重新授权' : '打开钉钉授权页',
            }, busy === 'login' ? '正在启动…' : '登录钉钉'),
            h('button', {
              style: button(S.buttonDanger, Boolean(busy) || !connected && state !== 'expired'),
              disabled: Boolean(busy) || (!connected && state !== 'expired'),
              onClick: logout,
            }, busy === 'logout' ? '正在退出…' : '退出登录'),
            h('button', { style: button(null, Boolean(busy)), disabled: Boolean(busy), onClick: refresh },
              busy === 'refresh' ? '刷新中…' : '刷新状态'),
            h('button', { style: button(null, Boolean(busy)), disabled: Boolean(busy), onClick: runDoctor },
              busy === 'doctor' ? '自检中…' : '环境自检')),

          loginUrl
            ? h('div', { style: S.card },
              h('div', { style: S.note }, '在浏览器打开以下链接完成钉钉授权（5 分钟内有效）：'),
              h('a', { style: S.link, href: loginUrl, target: '_blank', rel: 'noreferrer' }, loginUrl))
            : null,
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '这个连接器能做什么'),
          h('div', { style: S.note },
            'Agent 通过 `dingtalk_dws` 工具驱动官方钉钉 CLI：查通讯录与部门、看日程会议、收发群消息、'
            + '读写钉钉文档与在线表格、管理云盘文件、建待办、提交或审批 OA、查考勤、写日报周报、看 AI 听记、收发邮件、管理知识库。'),
          h('div', { style: S.note },
            '登录态由 dws 自己加密保存在本机（Windows 走 DPAPI），插件只负责发起授权、展示状态、撤销授权，不保存任何凭证。'),
        ),

        doctor
          ? h('div', { style: S.card },
            h('div', { style: S.title }, '环境自检'),
            h('pre', { style: S.pre }, doctor))
          : null,
      )
    }

    /**
     * 渲染失败边界。
     *
     * 没有它的话，子组件一抛错整格就被卸载，页面只是「空白」——从外面完全看不出原因。
     * 有了它至少能把错误文字给用户复制出来。
     */
    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failure: '' }
      }

      static getDerivedStateFromError(error) {
        return { failure: String((error && error.message) || error) }
      }

      render() {
        if (this.state.failure) {
          return h('div', { style: S.card },
            h('div', { style: S.title }, '钉钉连接器'),
            h('div', { style: S.error }, `面板渲染失败：${this.state.failure}`),
            h('div', { style: S.note }, 'Host 侧工具与路由不受影响；请把这段文字发出来便于定位。'))
        }
        return this.props.children
      }
    }

    /** 带边界的面板。 */
    function GuardedPanel(props) {
      return h(Guard, null, h(DingtalkPanel, props))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 唯一座位：插件详情页里本插件那一行。
        // 界面只归插件自己那一行所有，不额外注册 `settings.section`。
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          order: 40,
        }, GuardedPanel)), 'dingtalk-dws: plugin row panel')
      },
    }
  },
})
