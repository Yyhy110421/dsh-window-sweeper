/**
 * dsh-window-sweeper 浏览器半身：设置 → 清场。
 *
 * 读写的设置存放在宿主侧（/window-sweeper/settings），
 * 宿主每次执行 window_sweep 时都会重新读，改完立刻生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-window-sweeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'window-sweeper'

    const card = {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '4px 2px 20px',
      maxWidth: 640,
      fontSize: 13,
      lineHeight: 1.55,
      color: 'inherit',
    }
    const row = { display: 'flex', flexDirection: 'column', gap: 6 }
    const label = { fontWeight: 600, opacity: 0.9 }
    const hint = { fontSize: 12, opacity: 0.65 }
    const area = {
      width: '100%',
      minHeight: 64,
      padding: '8px 10px',
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid rgba(127,127,127,0.4)',
      borderRadius: 8,
      resize: 'vertical',
      boxSizing: 'border-box',
    }
    const button = {
      alignSelf: 'flex-start',
      padding: '7px 18px',
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(127,127,127,0.14)',
      border: '1px solid rgba(127,127,127,0.45)',
      borderRadius: 8,
      cursor: 'pointer',
    }

    function Panel() {
      const [state, setState] = React.useState({
        loading: true,
        action: 'minimize',
        excludeExe: [],
        excludeTitleKeywords: [],
        message: '',
        saving: false,
      })

      React.useEffect(() => {
        let alive = true
        fetch('/window-sweeper/settings')
          .then((res) => res.json())
          .then((body) => {
            if (!alive || !body || !body.settings) return
            const s = body.settings
            setState((prev) => ({
              ...prev,
              loading: false,
              action: s.action === 'close' ? 'close' : 'minimize',
              excludeExe: Array.isArray(s.excludeExe) ? s.excludeExe : [],
              excludeTitleKeywords: Array.isArray(s.excludeTitleKeywords) ? s.excludeTitleKeywords : [],
            }))
          })
          .catch(() => {
            if (alive) setState((prev) => ({ ...prev, loading: false, message: '读取设置失败：宿主路由不可用。' }))
          })
        return () => {
          alive = false
        }
      }, [])

      function save() {
        setState((prev) => ({ ...prev, saving: true, message: '' }))
        fetch('/window-sweeper/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: state.action,
            excludeExe: state.excludeExe,
            excludeTitleKeywords: state.excludeTitleKeywords,
          }),
        })
          .then((res) => res.json())
          .then((body) => {
            if (!body || body.ok !== true) throw new Error((body && body.error) || '保存失败')
            setState((prev) => ({ ...prev, saving: false, message: '已保存。下次 window_sweep 立即生效。' }))
          })
          .catch((error) => {
            setState((prev) => ({ ...prev, saving: false, message: '保存失败：' + String(error && error.message ? error.message : error) }))
          })
      }

      const radio = (value, text, desc) =>
        h(
          'label',
          { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
          h('input', {
            type: 'radio',
            name: 'window-sweeper-action',
            checked: state.action === value,
            onChange: () => setState((prev) => ({ ...prev, action: value })),
            style: { marginTop: 2 },
          }),
          h('span', null, h('span', null, text), h('span', { style: { ...hint, display: 'block' } }, desc)),
        )

      const listText = (items) => (Array.isArray(items) ? items.join('\n') : '')

      return h(
        'div',
        { style: card },
        h('div', { style: label }, '清场：任务收尾时收掉 AI 自己开的窗口'),
        h('div', { style: hint }, 'AI 用 window_sweep 工具执行；基线在每个任务开始时自动拍下，用户原本开着的窗口不会被收。'),
        h(
          'div',
          { style: row },
          h('div', { style: label }, '收场动作'),
          radio('minimize', '最小化（默认）', '可恢复，最安全。'),
          radio('close', '直接关闭', '向窗口发 WM_CLOSE，会真的关掉程序。'),
        ),
        h(
          'div',
          { style: row },
          h('div', { style: label }, '永不触碰的进程（每行一个）'),
          h('textarea', {
            style: area,
            value: listText(state.excludeExe),
            onChange: (event) => setState((prev) => ({ ...prev, excludeExe: event.target.value.split('\n') })),
            spellCheck: false,
          }),
          h('div', { style: hint }, '按进程名匹配，例如 explorer、chrome。默认已排除系统外壳进程。'),
        ),
        h(
          'div',
          { style: row },
          h('div', { style: label }, '标题关键词黑名单（每行一个）'),
          h('textarea', {
            style: area,
            value: listText(state.excludeTitleKeywords),
            onChange: (event) => setState((prev) => ({ ...prev, excludeTitleKeywords: event.target.value.split('\n') })),
            spellCheck: false,
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'center' } },
          h('button', { style: button, onClick: save, disabled: state.saving || state.loading }, state.saving ? '保存中…' : '保存'),
          h('span', { style: hint }, state.loading ? '读取中…' : state.message),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: NS,
              order: 40,
              label: () => '清场',
            },
            Panel,
          ),
        )
      },
    }
  },
})
