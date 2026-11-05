/**
 * dsh-window-sweeper（清场）宿主半身。
 *
 * 目标：AI 做完一个任务后，把自己这次新开出来的窗口最小化或关掉，
 * 不碰用户原本开着的窗口。
 *
 * 做法：会话创建时（agent/created）给当前可见窗口拍一张基线快照；
 * 收尾时枚举窗口，只把「不在基线里、且进程是基线之后才启动」的窗口
 * 交给 user32 处理（ShowWindow / WM_CLOSE，见 lib/windows.ps1）。
 *
 * 仅 Windows；零第三方依赖。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'window-sweeper'
export const inject = ['tools', 'systemPrompt', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'windows.ps1')

const SYSTEM_EXCLUDES = [
  'explorer',
  'ShellExperienceHost',
  'StartMenuExperienceHost',
  'SearchHost',
  'TextInputHost',
  'LockApp',
]

const DEFAULT_SETTINGS = {
  action: 'minimize',
  excludeExe: [...SYSTEM_EXCLUDES],
  excludeTitleKeywords: [],
}

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
}

const SETTINGS_FILE = join(dshHome(), 'data', 'window-sweeper.json')

function asStringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    action: src.action === 'close' ? 'close' : 'minimize',
    excludeExe: asStringArray(src.excludeExe, DEFAULT_SETTINGS.excludeExe),
    excludeTitleKeywords: asStringArray(src.excludeTitleKeywords, DEFAULT_SETTINGS.excludeTitleKeywords),
  }
}

function readSettings(baseline) {
  let stored = {}
  try {
    stored = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    stored = {}
  }
  return normalizeSettings({ ...baseline, ...stored })
}

function writeSettings(patch, baseline) {
  const next = normalizeSettings({ ...readSettings(baseline), ...patch })
  const dir = dirname(SETTINGS_FILE)
  mkdirSync(dir, { recursive: true })
  const tmp = SETTINGS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, SETTINGS_FILE)
  return next
}

function runPs(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim().slice(0, 600)
          reject(new Error('窗口引擎调用失败：' + detail))
          return
        }
        const text = String(stdout || '').trim()
        if (text === '') {
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(text)
          resolve(Array.isArray(parsed) ? parsed : [parsed])
        } catch {
          reject(new Error('窗口引擎返回无法解析：' + text.slice(0, 300)))
        }
      },
    )
  })
}

async function listWindows() {
  if (process.platform !== 'win32') throw new Error('清场目前只支持 Windows。')
  return await runPs(['-Action', 'list'])
}

function isExcluded(win, settings) {
  const exe = String(win.exe || '').toLowerCase()
  if (settings.excludeExe.some((item) => item.toLowerCase() === exe)) return true
  const title = String(win.title || '')
  return settings.excludeTitleKeywords.some((keyword) => keyword !== '' && title.includes(keyword))
}

function startedBefore(win, at) {
  const parsed = Date.parse(String(win.startedAt || ''))
  if (!Number.isFinite(parsed)) return false
  return parsed < at - 3000
}

function slim(win) {
  return {
    hwnd: Number(win.hwnd),
    pid: Number(win.pid),
    exe: String(win.exe || ''),
    title: String(win.title || ''),
    className: String(win.className || ''),
    minimized: win.minimized === true,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - cordis.patch.yml 里的插件配置。
 */
export function apply(ctx, config) {
  const baselineConfig = normalizeSettings(config || {})
  /** sessionId -> { at, hwnds:Set<number> } */
  const snapshots = new Map()

  async function mark(sessionId) {
    const list = await listWindows()
    const snap = {
      at: Date.now(),
      hwnds: new Set(list.map((win) => Number(win.hwnd))),
      pids: new Set(list.map((win) => Number(win.pid))),
    }
    snapshots.set(sessionId, snap)
    return { snap, list }
  }

  /**
   * 收场自动清场：按当前会话基线筛出本次新开的窗口，直接执行设置里的动作。
   * 不依赖模型是否记得调用 window_sweep。
   */
  async function sweepNow(sessionId, wanted = null) {
    const snap = snapshots.get(sessionId)
    if (!snap) return { action: 'skip', reason: 'no-baseline', applied: [] }
    const settings = readSettings(baselineConfig)
    const list = await listWindows()
    const candidates = list.filter((win) => {
      if (snap.hwnds.has(Number(win.hwnd))) return false
      if (snap.pids.has(Number(win.pid))) return false
      if (isExcluded(win, settings)) return false
      if (startedBefore(win, snap.at)) return false
      if (wanted !== null && !wanted.has(Number(win.hwnd))) return false
      return true
    })
    const targets = candidates.filter((win) => (settings.action === 'minimize' ? win.minimized !== true : true))
    if (targets.length === 0) return { action: settings.action, applied: [], candidates: candidates.map(slim) }
    const idList = targets.map((win) => Number(win.hwnd)).join(',')
    const results = await runPs(['-Action', settings.action, '-Hwnds', idList])
    return { action: settings.action, applied: results, candidates: candidates.map(slim) }
  }

  // 每个会话（agent）创建时自动拍基线：用户此前开着的窗口一个都不许动。
  try {
    ctx.effect(
      () =>
        ctx.on('agent/created', ({ agent }) => {
          const sessionId = agent && agent.session && agent.session.id
          if (typeof sessionId === 'string' && sessionId !== '') {
            void mark(sessionId).catch((error) => {
              console.warn('[window-sweeper] baseline snapshot failed:', error && error.message)
            })
          }
        }),
      'window-sweeper: baseline on agent/created',
    )
  } catch (error) {
    console.warn('[window-sweeper] agent/created hook unavailable:', error && error.message)
  }

  // 每个主会话（非子任务）收尾时自动清场，避免“模型忘了调工具”就留下窗口。
  try {
    ctx.effect(
      () =>
        ctx.on('agent/turn-stopping', ({ agent, signal }) => {
          if (signal && signal.aborted) return
          const session = agent && agent.session
          const sessionId = session && session.id
          if (typeof sessionId !== 'string' || sessionId === '') return
          const header = session.header
          if (header && (header.origin === 'subagent' || header.parentSession !== undefined)) return
          void sweepNow(sessionId).catch((error) => {
            console.warn('[window-sweeper] auto sweep failed:', error && error.message)
          })
        }),
      'window-sweeper: auto sweep on turn-stopping',
    )
  } catch (error) {
    console.warn('[window-sweeper] turn-stopping hook unavailable:', error && error.message)
  }

  const tool = {
    name: 'window_sweep',
    description:
      '清场：收起 AI 在本次任务中新打开的窗口（浏览器、播放器、安装器、控制台等），不碰用户原本开着的窗口。' +
      'action=mark 立即重拍基线；action=list 只列出候选窗口不执行；action=minimize 最小化（默认，可恢复）；action=close 关闭。' +
      '任务收尾时用 list 先看一眼，再用 minimize 或 close 收掉；也可以只对指定 hwnds 执行。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['mark', 'list', 'minimize', 'close'],
          description: 'mark 重拍基线；list 列候选；minimize 最小化；close 关闭。',
        },
        hwnds: {
          type: 'array',
          items: { type: 'number' },
          description: '只处理这些窗口句柄（可选，通常来自上一次 list 的结果）。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          baselineAt: { type: 'string' },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          applied: { type: 'array', items: { type: 'object', additionalProperties: true } },
          remaining: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        const lines = []
        const action = String(result.action || args.action || '')
        if (action === 'mark') {
          lines.push('清场：已重拍基线，记下 ' + String(result.marked ?? 0) + ' 个可见窗口。')
        } else if (action === 'list') {
          const candidates = Array.isArray(result.candidates) ? result.candidates : []
          lines.push('清场：本次任务以来新出现的窗口 ' + String(candidates.length) + ' 个（基线 ' + String(result.baselineAt || '') + '）。')
          for (const win of candidates.slice(0, 20)) {
            lines.push('- ' + String(win.title || '(无标题)') + '  [' + String(win.exe || win.className || '') + ']')
          }
        } else if (action === 'minimize' || action === 'close') {
          const applied = Array.isArray(result.applied) ? result.applied : []
          const remaining = Array.isArray(result.remaining) ? result.remaining : []
          lines.push('清场（' + action + '）：处理 ' + String(applied.length) + ' 个窗口，剩余未收 ' + String(remaining.length) + ' 个。')
          for (const win of applied.slice(0, 20)) {
            lines.push('- ' + (win.ok === false ? '失败：' : '已收：') + String(win.title || '(无标题)') + '  [' + String(win.exe || '') + ']')
          }
          for (const win of remaining.slice(0, 10)) {
            lines.push('- 仍在：' + String(win.title || '(无标题)') + '  [' + String(win.exe || '') + ']')
          }
        }
        if (typeof result.note === 'string' && result.note !== '') lines.push(result.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 40000,
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const action = String(args.action || 'list')
      const sessionId = (exec && exec.agent && exec.agent.session && exec.agent.session.id) || 'global'
      const settings = readSettings(baselineConfig)

      if (action === 'mark') {
        const { snap, list } = await mark(sessionId)
        return {
          ok: true,
          action: 'mark',
          marked: list.length,
          baselineAt: new Date(snap.at).toISOString(),
        }
      }

      const list = await listWindows()
      let snap = snapshots.get(sessionId)
      let note = ''
      if (!snap) {
        snap = {
          at: Date.now(),
          hwnds: new Set(list.map((win) => Number(win.hwnd))),
          pids: new Set(list.map((win) => Number(win.pid))),
        }
        snapshots.set(sessionId, snap)
        note = '本次会话此前没有基线，刚刚用当前窗口补拍；因此这次没有可收的候选。'
      }

      const wanted = Array.isArray(args.hwnds) ? new Set(args.hwnds.map((item) => Number(item))) : null
      const candidates = list.filter((win) => {
        if (snap.hwnds.has(Number(win.hwnd))) return false
        if (snap.pids.has(Number(win.pid))) return false
        if (isExcluded(win, settings)) return false
        if (startedBefore(win, snap.at)) return false
        if (wanted !== null && !wanted.has(Number(win.hwnd))) return false
        return true
      })

      if (action === 'list') {
        return {
          ok: true,
          action: 'list',
          baselineAt: new Date(snap.at).toISOString(),
          candidates: candidates.map(slim),
          note,
        }
      }

      if (action !== 'minimize' && action !== 'close') {
        throw new Error('未知 action：' + action + '（可选 mark / list / minimize / close）')
      }

      const targets = candidates.filter((win) => (action === 'minimize' ? win.minimized !== true : true))
      if (targets.length === 0) {
        return {
          ok: true,
          action,
          baselineAt: new Date(snap.at).toISOString(),
          candidates: candidates.map(slim),
          applied: [],
          remaining: [],
          note: note || '没有需要收的新窗口。',
        }
      }

      const idList = targets.map((win) => Number(win.hwnd)).join(',')
      const results = await runPs(['-Action', action, '-Hwnds', idList])
      const okById = new Map(results.map((item) => [Number(item.hwnd), item.ok === true]))
      let applied = targets.map((win) => ({ ...slim(win), ok: okById.get(Number(win.hwnd)) !== false }))

      let remaining = []
      if (action === 'close') {
        await sleep(800)
        const after = await listWindows()
        const alive = new Set(after.map((win) => Number(win.hwnd)))
        remaining = applied.filter((win) => alive.has(win.hwnd)).map(({ ok, ...rest }) => rest)
        applied = applied.map((win) => ({ ...win, ok: !alive.has(win.hwnd) && win.ok }))
      }

      return {
        ok: true,
        action,
        baselineAt: new Date(snap.at).toISOString(),
        candidates: candidates.map(slim),
        applied,
        remaining,
        note,
      }
    },
  }

  ctx.tools.register(tool)

  // 系统提示：告诉模型什么时候收场、怎么收。
  try {
    ctx.systemPrompt.section({
      name: 'tool:window-sweeper',
      order: 151,
      text:
        '收场时若本次任务自己打开过窗口（浏览器预览、播放器、安装器、控制台等），先调用 window_sweep action=list 看一眼，' +
        '再用 action=minimize（默认，可恢复）或 action=close 收掉；不要收用户原本开着的窗口。' +
        '内置浏览器会话用 dsh_browser_reset_session 收掉本会话标签页。',
    })
  } catch (error) {
    console.warn('[window-sweeper] system prompt section unavailable:', error && error.message)
  }

  // 设置读写路由：供设置界面读写。
  try {
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return
      const dispose = webServer.register({
        kind: 'exact',
        path: '/window-sweeper/settings',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(body))
          }
          if (req.method === 'GET') {
            send(200, { ok: true, settings: readSettings(baselineConfig) })
            return
          }
          if (req.method !== 'POST') {
            send(405, { ok: false, error: 'method not allowed' })
            return
          }
          let raw = ''
          try {
            for await (const chunk of req) raw += chunk
          } catch {
            send(400, { ok: false, error: 'bad body' })
            return
          }
          let patch = {}
          try {
            patch = JSON.parse(raw || '{}')
          } catch {
            send(400, { ok: false, error: 'invalid json' })
            return
          }
          try {
            send(200, { ok: true, settings: writeSettings(patch, baselineConfig) })
          } catch (error) {
            send(500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })
      if (typeof dispose === 'function') {
        try {
          ctx.effect(() => dispose, 'window-sweeper: settings route')
        } catch {
          /* noop */
        }
      }
    })
  } catch (error) {
    console.warn('[window-sweeper] settings route unavailable:', error && error.message)
  }
}
