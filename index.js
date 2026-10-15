/**
 * 钉钉 Workspace CLI（dws）↔ DeepSeek Harness 连接器（Host 半边）。
 *
 * 这一半只做四件事：
 *
 *   1. `dingtalk_dws`  —— 把官方 `dws` CLI 作为 DSH 工具暴露给 Agent（唯一执行入口）；
 *   2. `dingtalk_auth_status` —— 不发起业务请求即可回答「连没连上、连的是谁」；
 *   3. 钉钉技能知识 —— 通过 `skills` 注册一个懒加载 provider，把 dws 的使用契约交给 Agent；
 *   4. 面板接口 —— 在 `webServer` 上注册只读状态 / 登录 / 退出三条路由，供浏览器半边显示。
 *
 * 设计约束（对齐 dws 官方 CLI 的用法约定）：
 *
 *   - 始终以 `dws` 为唯一执行入口，禁止 curl / 直连 HTTP API / 浏览器旁路；
 *   - 业务命令统一带 `--format json`；flag 用 kebab-case；
 *   - 不编造 ID：ID 必须从命令返回里取；
 *   - 危险操作（删文档/删表/撤回/拒绝审批等）必须先取得用户同意再加 `--yes`；
 *   - 登录走 `auth login --no-browser`，把 URL 提取出来交给用户在浏览器打开，
 *     绝不自行弹浏览器；退出走 `auth logout`。
 *
 * 子进程优先走 `ctx.subprocess`，拿不到时退回 Node 原生 `child_process`
 * （`AbortSignal` 直连调用方）；失败一律转成结构化的工具结果，
 * 不会把异常抛进 Harness 主循环。
 *
 * @module dsh-plugin-dingtalk-dws
 */

import { existsSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 函数插件名。 */
export const name = 'dingtalk-dws'

/**
 * 只注入**确实存在于根 scope** 的服务。
 *
 * 两个反直觉的 Cordis 语义，都是实测踩出来的：
 *
 *  1. 注入的服务缺一个，整个插件就**不会被 apply**（不是延迟，是直接不上）。
 *     第一版只 inject `['tools']`，于是插件在 `webServer`/`connection` 就绪前
 *     就 apply 了：工具注册上了，设置页路由却静默 404。
 *  2. 反过来，把**不存在**的服务写进 inject 会让插件彻底消失。
 *     我一度加了 `subprocess`，结果工具和路由全没了——
 *     `subprocess` 在根 scope 上不是可注入服务（它的行状态是 `absent`），
 *     只存在于 Agent 运行环境里。所以它必须走运行时可选探测。
 *
 * 结论：`tools`/`webServer`/`connection` 是硬依赖（确实存在，且必须在就绪后才 apply）；
 * `subprocess`/`skills`/`systemPrompt` 一律运行时探测，缺了就走替代路径。
 */
export const inject = ['tools', 'webServer', 'connection']

/** 设置页路径前缀。 */
const ROUTE_PREFIX = '/dingtalk-dws'

/** 只读状态与授权操作不等同于业务命令，给它们独立的短超时。 */
const STATUS_TIMEOUT_MS = 20_000
const LOGOUT_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 600_000
const PROBE_TIMEOUT_MS = 25_000

/** 状态缓存时长：正常情况 10s 内不重复起进程，且**永不**在后台自动轮询。 */
const STATUS_CACHE_MS = 10_000
/** 强制刷新（`?fresh=1`）之间的最小间隔，避免把 refresh_token 反复轮转掉。 */
const STATUS_FORCE_MIN_MS = 30_000
/** 实时状态页前端轮询间隔（毫秒）。 */
const STATUS_POLL_MS = 15_000

/** 插件配置。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  executable: z.string().default(''),
  profile: z.string().default(''),
  execTimeoutMs: z.number().default(60_000),
  maxOutputBytes: z.number().default(60_000),
  exposeRawApi: z.boolean().default(false),
  registerSkill: z.boolean().default(true),
})

/** 官方仓库里那份已锁定版本的 CLI 地址（仅用于报错时提示，插件不会自己去下载）。 */
const OFFICIAL_CLI_VERSION = '1.0.59'

/** `dws` 自己会读的技能目录；存在时说明用户已经装过一份 CLI。 */
function defaultDwsHome() {
  return process.env.DWS_CONFIG_DIR || join(process.env.USERPROFILE || homedir(), '.dws')
}

/**
 * 展开 `~` 与 `%VAR%` / `$VAR`，并做一次轻量路径归一化。
 * @param {string} value 用户给的路径。
 * @returns {string} 展开后的路径。
 */
function expandPath(value) {
  let out = String(value || '').trim()
  if (!out) return ''
  const home = process.env.USERPROFILE || homedir()
  if (out === '~') out = home
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(home, out.slice(2))
  out = out.replace(/%([^%]+)%/g, (whole, key) => process.env[key] ?? whole)
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) => process.env[key] ?? whole)
  return out
}

/**
 * 把任意超时值夹到安全区间。
 * @param {unknown} value 候选毫秒数。
 * @param {number} fallback 不可用时的回退值。
 * @param {number} cap 上限。
 * @returns {number} 可用的毫秒数。
 */
function clampTimeout(value, fallback, cap) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), cap)
}

/**
 * 解析一段可能混着横幅 / 日志 / 多个 JSON 文档的输出，取出其中所有完整的顶层 JSON 值。
 * 与官方 Provider 的括号配平思路一致，但按顶层顺序收集全部文档。
 * @param {string} text 原始输出。
 * @returns {{ values: unknown[], remainder: string }} 解析出的值，以及扣掉这些值之后的残余文本。
 */
function extractJsonDocuments(text) {
  const values = []
  let remainder = ''
  const source = String(text ?? '')
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char !== '{' && char !== '[') {
      remainder += char
      index += 1
      continue
    }
    const start = index
    let depth = 0
    let quoted = false
    let escaped = false
    let end = -1
    for (; index < source.length; index += 1) {
      const current = source[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === '"') quoted = false
        continue
      }
      if (current === '"') quoted = true
      else if (current === '{' || current === '[') depth += 1
      else if (current === '}' || current === ']') {
        depth -= 1
        if (depth === 0) { end = index + 1; index = end; break }
      }
    }
    if (end < 0) { remainder += source.slice(start); break }
    try {
      values.push(JSON.parse(source.slice(start, end)))
    } catch {
      remainder += source.slice(start, end)
    }
  }
  return { values, remainder: remainder.trim() }
}

/**
 * 从一段文本里找出第一个 http(s) 链接，用于 `auth login --no-browser` 的授权地址提取。
 * @param {string} text 候选文本。
 * @returns {string} 授权链接，找不到时返回空串。
 */
function firstHttpUrl(text) {
  const match = /https?:\/\/[^\s"'<>\\]+/i.exec(String(text ?? ''))
  if (!match) return ''
  return match[0].replace(/[),.;]+$/, '')
}

/**
 * 把字节数说成人话。
 * @param {number} bytes 字节数。
 * @returns {string} 人类可读的大小。
 */
function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 按 UTF-8 上限截断文本，并给出明确的截断标记。
 * @param {string} text 原文本。
 * @param {number} maxBytes 上限字节数。
 * @returns {{ text: string, truncated: boolean }} 截断结果。
 */
function truncateText(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  if (buffer.byteLength <= maxBytes) return { text: String(text ?? ''), truncated: false }
  const head = buffer.subarray(0, Math.max(0, maxBytes)).toString('utf8')
  return {
    text: `${head}\n…[输出被截断：原始 ${humanBytes(buffer.byteLength)}，上限 ${humanBytes(maxBytes)}]`,
    truncated: true,
  }
}

/**
 * 从 `profile list` 的记录里挑出当前账号。
 * @param {unknown} payload `profile list` 的解析结果。
 * @returns {Record<string, any> | undefined} 当前账号记录。
 */
function currentProfileOf(payload) {
  const record = payload && typeof payload === 'object' ? payload : {}
  const profiles = Array.isArray(record.profiles) ? record.profiles : []
  const current = String(record.currentProfile || '')
  const byFlag = profiles.find((item) => item && typeof item === 'object' && item.isCurrent === true)
  if (byFlag) return byFlag
  if (current) {
    const byName = profiles.find((item) => item && typeof item === 'object'
      && (String(item.corpId) === current || String(item.corpName) === current))
    if (byName) return byName
  }
  return profiles.length === 1 ? profiles[0] : undefined
}

/**
 * 把 `dws auth status` 的返回归一成连接器自己的状态词。
 * @param {Record<string, any>} payload 解析后的状态对象。
 * @returns {string} connected / expired / configured / unauthenticated。
 */
function authStateOf(payload) {
  if (!payload || payload.authenticated !== true) return 'unauthenticated'
  if (payload.token_valid === true) return 'connected'
  if (payload.refresh_token_valid === true) return 'expired'
  return 'configured'
}

/**
 * 拼一条可直接复制的 dws 命令行（仅用于展示与日志，永不交给 shell 执行）。
 * @param {string} bin 逻辑命令名。
 * @param {string[]} argv 参数数组。
 * @returns {string} 展示用命令行。
 */
function formatCommand(bin, argv) {
  return [bin, ...argv]
    .map((part) => (/[\s"]/.test(part) ? `"${String(part).replaceAll('"', '\\"')}"` : part))
    .join(' ')
}

/**
 * 检查 CLI 版本是否满足插件假定的最低版本。
 * @param {string} raw `dws version` 的原始输出。
 * @returns {boolean | undefined} true 满足，false 不满足，undefined 无法判断。
 */
function versionAtLeastExpected(raw) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? ''))
  if (!match) return undefined
  const [, major, minor] = match.map(Number)
  return major > 1 || (major === 1 && minor >= 0)
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {z.infer<typeof Config>} config 解析后的配置。
 */
export function apply(ctx, config) {
  const enabled = config.enabled !== false
  const maxOutputBytes = Math.max(4096, Number(config.maxOutputBytes) || 60_000)
  const execTimeoutMs = clampTimeout(config.execTimeoutMs, 60_000, 600_000)
  const profileArg = String(config.profile || '').trim()

  /**
   * 读服务：**注入过的**直接读属性，**没注入的**只能走 `ctx.get()`。
   *
   * Cordis 的 Context 是个 Proxy：读一个没有 inject 过的服务属性会**直接抛错**
   * （`cannot get property "subprocess" without inject`），不是返回 undefined。
   * 早期版本用 `ctx[key] !== undefined ? ctx[key] : ctx.get(key)` 探测服务，
   * 结果第一行就把插件炸掉了 —— 表现为「工具和路由全都没有」，而界面只看到 404。
   * 这是 `plugin_manager set_bundle` 的激活诊断报出来的原始错误。
   *
   * @param {string} key 服务名。
   * @returns {any} 服务实例，或 undefined。
   */
  const injected = new Set(inject)
  const getService = (key) => {
    if (injected.has(key)) {
      if (ctx[key] !== undefined) return ctx[key]
    }
    // `ctx.get()` 明确是「不做 inject 要求」的读取入口，对任何名字都安全。
    try {
      return ctx.get?.(key)
    } catch {
      return undefined
    }
  }
  // 注入过的：这三个由 Cordis 保证就绪。
  const webServer = getService('webServer')
  const connection = getService('connection')
  const tools = getService('tools')
  // 没注入的：根 scope 上可能不存在，必须走 runtime 探测。
  const subprocess = getService('subprocess')
  const skills = getService('skills')
  const systemPrompt = getService('systemPrompt')

  const log = (message) => ctx.logger?.info?.(`dingtalk-dws: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`dingtalk-dws: ${message}`)

  /** 运行期诊断状态。 */
  const state = { webRoutesRegistered: 0, webRouteError: '' }

  /** 缓存的二进制绝对路径，探测一次就记住。 */
  let cachedBinary = ''
  let cachedBinarySource = ''
  /** 状态缓存，避免反复起进程（`profile list` 默认不刷新 token，但仍不必每次起进程）。 */
  let statusCache = { at: 0, value: undefined }
  let lastForcedStatusAt = 0
  /** 当前正在跑的登录进程。 */
  let loginProcess = null
  let loginUrl = ''
  let loginStartedAt = 0
  let loginError = ''

  /**
   * 候选的可执行文件所在位置，按优先级排列。
   * @returns {Array<{ path: string, source: string }>} 候选列表。
   */
  function binaryCandidates() {
    const candidates = []
    const configured = expandPath(config.executable)
    if (configured) candidates.push({ path: configured, source: 'config.executable' })
    const dshRuntime = process.env.DSH_HOME
      ? join(process.env.DSH_HOME, 'dsh-runtimes', 'dingtalk-dws', 'dws.exe')
      : ''
    if (dshRuntime) candidates.push({ path: dshRuntime, source: 'DSH_HOME 受管运行时' })
    const dwsHome = defaultDwsHome()
    candidates.push({ path: join(dwsHome, 'bin', 'dws.exe'), source: 'DWS_CONFIG_DIR/bin' })
    candidates.push({ path: join(process.env.USERPROFILE || homedir(), '.local', 'bin', 'dws.exe'), source: '~/.local/bin' })
    return candidates
  }

  /**
   * 解析出真正要执行的命令。裸名字（`dws`）交给 `ctx.subprocess.resolveExecutable`，
   * 这样解释器和 PATH 规则与 Harness 其它工具完全一致。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<{ command: string, source: string }>} 可执行命令与来源说明。
   */
  async function resolveBinary(signal) {
    if (cachedBinary) return { command: cachedBinary, source: cachedBinarySource }
    for (const candidate of binaryCandidates()) {
      if (!candidate.path || !existsSync(candidate.path)) continue
      cachedBinary = candidate.path
      cachedBinarySource = `${candidate.source}：${candidate.path}`
      log(`使用 dws：${cachedBinarySource}`)
      return { command: cachedBinary, source: cachedBinarySource }
    }
    const bare = expandPath(config.executable) || 'dws'
    if (subprocess?.resolveExecutable) {
      try {
        const resolved = await subprocess.resolveExecutable(bare, undefined, signal)
        cachedBinary = resolved
        cachedBinarySource = `PATH：${resolved}`
        log(`使用 dws：${cachedBinarySource}`)
        return { command: resolved, source: cachedBinarySource }
      } catch (error) {
        warn(`PATH 上找不到 ${bare}：${String(error?.message || error)}`)
      }
    }
    throw new Error(
      `找不到钉钉 CLI（dws）。请在插件设置里指定 dws.exe 的绝对路径，或把它放到 PATH 上。`
      + `插件假定的是官方 ${OFFICIAL_CLI_VERSION} 版本；确认已安装可执行 dws version 检查。`,
    )
  }

  /**
   * 起一个 dws 子进程，返回统一形状的句柄。
   *
   * 两条实现路径：
   *
   *   - `ctx.subprocess.spawn` —— Harness 的执行世界，尊重它的终止阶梯与配额；
   *   - Node 原生 `child_process.spawn` —— 根 scope 上拿不到 `subprocess` 时的退路。
   *
   * @param {{ command: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal }} spec 启动参数。
   * @returns {{ stdin: any, stdout: any, stderr: any, done: Promise<{exitCode: number|null, signal: string|null}>, terminate: () => void, transport: string }} 句柄。
   */
  function spawnDwsProcess(spec) {
    if (subprocess?.spawn) {
      try {
        const handle = subprocess.spawn({
          argv: [spec.command, ...spec.args],
          cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          env: spec.env,
          graceMs: 5_000,
          signal: spec.signal,
        })
        return {
          stdin: handle.stdin,
          stdout: handle.stdout,
          stderr: handle.stderr,
          done: Promise.resolve(handle.done).then((outcome) => ({
            exitCode: outcome?.exitCode ?? null,
            signal: outcome?.signal ?? null,
          })),
          terminate: () => handle.terminate(),
          transport: 'ctx.subprocess',
        }
      } catch (error) {
        warn(`ctx.subprocess.spawn 失败，改用 Node 原生进程：${String(error?.message || error)}`)
      }
    }

    const child = nodeSpawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let terminated = false
    const terminate = () => {
      if (terminated) return
      terminated = true
      try { child.kill('SIGTERM') } catch { /* 已经退出 */ }
    }
    if (spec.signal.aborted) terminate()
    else spec.signal.addEventListener('abort', terminate, { once: true })

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      }),
      terminate,
      transport: 'node:child_process',
    }
  }

  /**
   * 起一个 dws 子进程并收集输出。
   *
   * 这是本插件唯一的进网路径：所有外部命令都必须经过这里。
   *
   * 优先用 Harness 的 `ctx.subprocess`（沿用它的执行世界与终止阶梯）；
   * 根 scope 上拿不到它时退回 Node 原生 `child_process`，两条路都返回同样的句柄形状，
   * 所以上层代码不需要分支。
   *
   * @param {string[]} args 参数数组（不含可执行文件本身）。
   * @param {object} [options] 运行选项。
   * @param {number} [options.timeoutMs] 超时。
   * @param {AbortSignal} [options.signal] 调用方（Agent 或 HTTP 请求）的取消信号。
   * @param {(chunk: string) => void} [options.onOutput] 增量回调，用于抓登录 URL。
   * @param {boolean} [options.detached] 是否把进程句柄交回调用方（登录流程需要）。
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number|null, signal: string|null, timedOut: boolean, durationMs: number, command: string, source: string, handle?: any }>} 运行结果。
   */
  async function runDws(args, options = {}) {
    const timeoutMs = clampTimeout(options.timeoutMs, execTimeoutMs, 900_000)
    const { command, source } = await resolveBinary(options.signal)

    const started = Date.now()
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason)
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const env = {
      ...process.env,
      ...(profileArg ? { DWS_PROFILE: profileArg } : {}),
    }

    const handle = spawnDwsProcess({ command, args, env, signal: controller.signal })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const pump = (stream, sink) => {
      if (!stream) return
      stream.setEncoding?.('utf8')
      stream.on('data', (chunk) => {
        const text = String(chunk)
        if (sink === 'out') {
          if (stdout.length < maxOutputBytes * 2) stdout += text
        } else if (stderr.length < maxOutputBytes * 2) stderr += text
        try { options.onOutput?.(text) } catch { /* 回调失败不影响主流程 */ }
      })
      stream.on('error', () => { /* 流错误由 done 统一表达 */ })
    }
    pump(handle.stdout, 'out')
    pump(handle.stderr, 'err')

    const timer = setTimeout(() => {
      timedOut = true
      try { handle.terminate() } catch { /* 忽略重复终止 */ }
    }, timeoutMs)

    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      if (options.detached) throw error
      outcome = { exitCode: null, signal: null }
      stderr += `\n[spawn 失败] ${String(error?.message || error)}`
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
    }

    const result = {
      stdout,
      stderr,
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      timedOut,
      durationMs: Date.now() - started,
      command: formatCommand('dws', args),
      source,
      transport: handle.transport,
    }
    if (options.detached) result.handle = handle
    return result
  }

  /**
   * 解析一次命令输出：拆出 JSON 文档、判断业务成败、给出可展示的正文。
   * @param {Awaited<ReturnType<typeof runDws>>} result 运行结果。
   * @returns {{ ok: boolean, code: string, message: string, data: unknown, values: unknown[], extraText: string, truncated: boolean }} 解析结果。
   */
  function interpret(result) {
    const combined = `${result.stdout}\n${result.stderr}`
    const parsed = extractJsonDocuments(result.stdout)
    const stderrDocs = extractJsonDocuments(result.stderr)
    // `dws` 的横幅里会出现一个空的 `[]`。空的容器不代表任何业务数据，
    // 把它当成 JSON 会把真正的纯文本输出（例如 `--help`）吃掉，所以这里滤掉。
    const isEmptyContainer = (value) => Array.isArray(value)
      ? value.length === 0
      : Boolean(value) && typeof value === 'object' && Object.keys(value).length === 0
    const allValues = [...parsed.values, ...stderrDocs.values].filter((value) => !isEmptyContainer(value))
    const remainder = [parsed.remainder, stderrDocs.remainder].filter(Boolean).join('\n')
    const errorRecord = allValues.find((value) => value && typeof value === 'object' && !Array.isArray(value)
      && (value.success === false || value.error !== undefined || value.code !== undefined))

    let code = ''
    let message = ''
    if (errorRecord && typeof errorRecord === 'object') {
      const error = errorRecord.error && typeof errorRecord.error === 'object' ? errorRecord.error : undefined
      code = String(error?.code ?? errorRecord.code ?? errorRecord.reason ?? '')
      message = String(error?.message ?? errorRecord.message ?? errorRecord.errmsg ?? '')
    }
    if (!message && result.timedOut) message = `dws 命令超时（${result.durationMs} ms）后被终止`
    if (!message && result.exitCode !== 0) {
      const tail = combined.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' / ')
      message = tail || `dws 退出码 ${result.exitCode}`
    }

    const ok = result.exitCode === 0 && !result.timedOut && errorRecord === undefined
    const body = allValues.length === 1 ? allValues[0] : allValues.length === 0 ? undefined : allValues
    const extraText = remainder
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^[─▍•·\s]+$/.test(line))
      .join('\n')

    const sized = truncateText(body === undefined ? '' : JSON.stringify(body, null, 2), maxOutputBytes)
    return {
      ok,
      code,
      message,
      data: body,
      errorRecord,
      extraText: truncateText(extraText, Math.max(2000, Math.floor(maxOutputBytes / 4))).text,
      truncated: sized.truncated,
      text: sized.text,
    }
  }

  /**
   * 读一次连接状态。
   *
   * `profile list` 只读真实 Token 状态、**不刷新**，所以它适合被界面轮询；
   * `auth status` 会尝试刷新、可能把 refresh_token 轮转掉，因此只在用户显式刷新时使用。
   *
   * @param {object} [options] 选项。
   * @param {boolean} [options.force] 强制刷新（忽略缓存）。
   * @param {AbortSignal} [options.signal] 取消信号。
   * @returns {Promise<Record<string, any>>} 状态快照。
   */
  async function readStatus(options = {}) {
    const now = Date.now()
    if (!options.force && statusCache.value && now - statusCache.at < STATUS_CACHE_MS) {
      return { ...statusCache.value, cached: true }
    }
    if (options.force && now - lastForcedStatusAt < STATUS_FORCE_MIN_MS && statusCache.value) {
      return { ...statusCache.value, cached: true, note: '刷新过于频繁，返回缓存结果' }
    }

    /**
     * 组装快照。
     *
     * 注意 `binary` 必须在 `runDws` **之后**读：二进制路径是第一次真正执行时才解析出来的，
     * 若提前读会永远显示「(尚未探测)」。
     *
     * @param {Record<string, any>} extra 本次状态字段。
     * @returns {Record<string, any>} 完整快照。
     */
    const snapshotOf = (extra) => ({
      plugin: name,
      enabled,
      checkedAt: new Date().toISOString(),
      cached: false,
      binary: cachedBinarySource || '(尚未探测)',
      profile: profileArg || '(默认账号)',
      // 路由没注册上时，面板自己也会连不上；把这个原因报出来便于一次定位。
      routeError: state.webRouteError,
      hint: '',
      ...extra,
    })

    try {
      const list = await runDws(['--format', 'json', 'profile', 'list'], { timeoutMs: STATUS_TIMEOUT_MS, signal: options.signal })
      const parsed = interpret(list)
      if (!parsed.ok && parsed.data === undefined) {
        const snapshot = snapshotOf({ state: 'cli_error', message: parsed.message || 'dws profile list 失败', raw: parsed.extraText })
        statusCache = { at: now, value: snapshot }
        return snapshot
      }
      const payload = parsed.data && typeof parsed.data === 'object' ? parsed.data : {}
      const profiles = Array.isArray(payload.profiles) ? payload.profiles : []
      const current = currentProfileOf(payload)
      if (!current) {
        const snapshot = snapshotOf({ state: 'unauthenticated', message: '没有登录任何钉钉组织', profiles: [] })
        statusCache = { at: now, value: snapshot }
        return snapshot
      }
      const expired = current.status !== 'active'
      const snapshot = snapshotOf({
        state: expired ? 'unauthenticated' : 'connected',
        message: expired ? '登录态已失效，请重新登录' : '',
        profiles: profiles.map((item) => ({
          corpId: String(item?.corpId ?? ''),
          corpName: String(item?.corpName ?? ''),
          userName: String(item?.userName ?? ''),
          status: String(item?.status ?? ''),
          isCurrent: item?.isCurrent === true,
          lastLoginAt: String(item?.lastLoginAt ?? ''),
        })),
        corpId: String(current.corpId ?? ''),
        corpName: String(current.corpName ?? ''),
        userName: String(current.userName ?? ''),
        expiresAt: String(current.lastLoginAt ?? ''),
      })
      statusCache = { at: now, value: snapshot }
      if (options.force) lastForcedStatusAt = now
      return snapshot
    } catch (error) {
      const snapshot = snapshotOf({
        state: 'cli_missing',
        message: String(error?.message || error),
        hint: `插件需要在配置里指定 dws.exe 路径，或把官方 dws ${OFFICIAL_CLI_VERSION} 放到 PATH 上。`,
      })
      statusCache = { at: now, value: snapshot }
      return snapshot
    }
  }

  /**
   * 探测 CLI 是否可用（用 `doctor`，失败再退到 `version`），并把结论说清楚。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<{ ok: boolean, text: string, detail?: unknown }>} 探测结果。
   */
  async function probeCli(signal) {
    try {
      const version = await runDws(['version'], { timeoutMs: PROBE_TIMEOUT_MS, signal })
      const versionText = `${version.stdout}`.trim().split(/\r?\n/)[0] || '(无输出)'
      const doctor = await runDws(['doctor'], { timeoutMs: PROBE_TIMEOUT_MS, signal })
      const combined = `${doctor.stdout}\n${doctor.stderr}`.trim()
      const lines = combined.split(/\r?\n/).filter((line) => line.trim()).slice(0, 40)
      const ok = doctor.exitCode === 0
      return {
        ok,
        text: [
          `dws 可执行：${versionText}`,
          `二进制来源：${version.source}`,
          `doctor 退出码：${doctor.exitCode}`,
          ...lines.map((line) => `  ${line}`),
        ].join('\n'),
        detail: { version: versionText, versionOk: versionAtLeastExpected(versionText), doctorExitCode: doctor.exitCode },
      }
    } catch (error) {
      return { ok: false, text: `dws 不可用：${String(error?.message || error)}` }
    }
  }

  /**
   * 读取官方技能正文，作为注册给 Agent 的知识。
   *
   * `/dws apply-config` 之类的自检不需要它；缺失时工具描述里的兜底说明仍然可用。
   *
   * @returns {string} 技能正文。
   */
  function bundledSkillContent() {
    return [
      '---',
      'name: dingtalk-dws',
      'description: 通过钉钉官方 Workspace CLI（dws）操作钉钉：通讯录、日程会议、群聊与机器人消息、AI 表格、'
        + '在线表格、钉钉文档、云盘、待办、OA 审批、考勤、日志、听记、邮箱、知识库。'
        + '当用户提到钉钉、DingTalk、同事/部门、日程/会议室、群/发消息、钉钉文档/云盘、待办、请假/报销审批、'
        + '考勤打卡、日报周报、会议纪要时必须使用。',
      '---',
      '',
      '# 钉钉 Workspace CLI（dws）',
      '',
      '钉钉能力由插件提供的一个工具执行：`dingtalk_dws`。它是对官方 `dws` CLI 的直通封装。',
      '',
      '## 用法',
      '',
      '```jsonc',
      // 只读：直接给 service 和子命令
      '{"service": ["contact", "user", "get-self"], "description": "查我自己是谁"}',
      // 带参数：参数以 flag 形式逐项给出（kebab-case，值紧跟其后）
      '{"service": ["calendar", "event", "list"], "args": ["--start", "2026-10-15", "--end", "2026-10-16"], "description": "列出今天的日程"}',
      // 子命令里有前导 `+` 的 shortcut、或参数值形如 flag，统一放进 args 更稳
      '{"args": ["chat", "+send-text", "--group", "<conversationId>", "--text", "hi"], "description": "往群里发消息"}',
      '```',
      '',
      '规则（违反会被工具直接拒绝）：',
      '',
      '1. **只用这个工具**，不要用 `bash` / `pwsh` 调 dws，也不要自己拼 `--format`；',
      '2. 工具会自动补 `--format json`，读结果里的 JSON 就好；',
      '3. **不要编造 ID**：baseId / tableId / recordId / conversationId / processInstanceId / eventId',
      '   都必须从前面某条命令的返回里取；',
      '4. **不要猜字段名**：先 `--help` 或先查列表，再执行写操作；',
      '5. 危险操作（删文档/删表/删字段/删记录、撤回消息、拒绝审批、删待办、移除群成员、改文档权限等）',
      '   **必须先向用户展示操作摘要并取得明确同意**，同意后才在 args 里加 `--yes`；',
      '6. 单次批量不超过 30 条记录。',
      '',
      '## 命令发现',
      '',
      '本机 `dws` 处于「静态端点模式」，`dws schema` 只返回本地有限 Schema，通常为空，',
      '所以**用各服务自己的帮助**来发现命令：',
      '',
      '```jsonc',
      '{"args": ["contact", "--help"], "description": "列出通讯录的子命令"}',
      '{"args": ["contact", "user", "--help"], "description": "列出人员查询的参数"}',
      '{"args": ["--help"], "description": "列出全部已发现的服务"}',
      '```',
      '',
      '先 `dws --help` 看服务清单，再 `dws <service> --help`，最后 `dws <service> <cmd> --help` 核对 flags。',
      '',
      '## 产品路由',
      '',
      '| 用户想说 | service |',
      '|---|---|',
      '| 找人 / 谁负责某事 / 按手机号或工号找人 | `aisearch`（首选）或 `contact` |',
      '| 通讯录、部门、组织架构、花名册、离职员工 | `contact` |',
      '| 日程、日历、会议室、闲忙 | `calendar` |',
      '| 群聊、群成员、发消息、机器人、Webhook | `chat` |',
      '| 待办、任务提醒 | `todo` |',
      '| 审批、请假、报销、出差、同意/拒绝 | `oa` |',
      '| 钉钉文档、读写文档、评论、权限 | `doc` |',
      '| 云盘、文件上传下载 | `drive` |',
      '| 在线电子表格（axls） | `sheet` |',
      '| AI 表格（多维表/记录/字段/视图） | `aitable` |',
      '| 考勤、打卡、排班、假期 | `attendance` |',
      '| 钉钉日志、日报周报 | `report` |',
      '| AI 听记、会议纪要、转写 | `minutes` |',
      '| 邮箱、收发邮件 | `mail` |',
      '| 知识库、空间、节点 | `wiki` |',
      '| DING 消息 | `ding` |',
      '| 组织/账号切换 | `profile` |',
      '',
      '## 只读文档的读取链路',
      '',
      '用户给一个 `https://alidocs.dingtalk.com/i/nodes/<nodeId>` 链接时，**nodeId 就是 URL 最后一段**，',
      '直接当 `--node` / `--base-id` 用，不必先解析。**按轮次并发执行，不要一条条串行试。**',
      '',
      '**第 1 轮（3 条并发）——定类型 + 定权限 + 定结构**',
      '',
      '| 命令 | 作用 |',
      '|---|---|',
      '| `doc info --node <nodeId>` | 定类型：`adoc` 文字文档 / `able` AI 表格 / `sheet` 在线表格 |',
      '| `drive permission list --node <nodeId>` | 定我的角色，顺带拿到 owner |',
      '| `aitable +section-list-nodes --base-id <nodeId>` | `able` 时拿数据表 id（它是唯一能拿到 tableId 的入口） |',
      '',
      '类型分支：`adoc` → `doc read --node <nodeId>`；`sheet` → `sheet` 服务；`able` → 继续往下。',
      '',
      '**第 2 轮——按角色分叉**',
      '',
      '- 角色 `OWNER` / `EDITOR` / `MANAGER`（可写）：`aitable field get` 拿列名 +',
      '  `aitable record query --limit 30` 拿行级明细，每张表 2 条并发，到此结束。',
      '- 角色 `READER` / `DOWNLOADER` / `ONLY_VIEWER`（只读）：**不要打 `+list-tables` / `field get` /',
      '  `record query`**——对只读它们恒定 403（`AUTH_ERROR`、`retryable:false`），打了纯属浪费。',
      '  直接走只读链路：',
      '  1. `aitable record ids --base-id <baseId> --table-id <tableId>` → 记录条数与全部 recordId；',
      '  2. 对每个 recordId 并发 `aitable +record-history-list --record-id <id>`，',
      '     从 `newValue` 里取**被写过的字段值**（key 就是字段 id）。',
      '',
      '**只读链路能拿到 / 拿不到**',
      '',
      '| 能拿到 | 拿不到 |',
      '|---|---|',
      '| 文档类型、名称、创建/修改时间 | 列名（`field get` 403） |',
      '| 目录结构（数据表 + 仪表盘） | 行级明细（`record query` 403） |',
      '| 记录条数与 recordId | 数据表清单（`+list-tables` 403） |',
      '| 每条记录被写过的字段值与写入时间 | 整表导出（`+export-data` 500） |',
      '',
      '**已知无效，别重复**',
      '',
      '| 尝试 | 结果 |',
      '|---|---|',
      '| `record group-stats` 按字段分组 | 只读下被服务端拒（`request parameters are invalid`），别靠它拼每行内容 |',
      '| 用别的表的字段 id 探测本表字段 | `FIELD_NOT_FOUND`——字段 id 每表独立，不能跨表套用 |',
      '',
      '**硬规则**',
      '',
      '- `403 + AUTH_ERROR + retryable:false` = 权限不够，不是参数错；**不换通路、不重试**。',
      '- 拿不到就是拿不到，**不要为了"验证接口是否正常"去读别的文档、别的 Base 或别的表**——',
      '  那是越权，用户没要求的事不做。',
      '- 只读角色不做任何写操作。',
      '- 结论一次给全：我的角色、owner 是谁、缺什么权限、能读到哪些、是否需要发起权限申请。',
      '',
      '**成本**：只读链路 3 轮 / `N+4` 次调用（N = 记录条数），0 个可预见的 403。',
      '',
      '## 多组织 / 多账号',
      '',
      '- 插件配置里的 `profile` 为空时使用 `isCurrent=true` 的账号；',
      '- 需要指定组织时用工具参数 `profile`（值为 `corpId:userId` 这类稳定标识），不要猜；',
      '- 先 `{"args": ["profile", "list"], "description": "列出全部钉钉账号"}` 拿到准确标识。',
      '',
      '## 出错怎么办',
      '',
      '1. 加 `--verbose` 重试一次；',
      '2. 输出里出现 `RECOVERY_EVENT_ID=<id>` 时，按 recovery 闭环走',
      '   （`dws recovery plan --event-id <id>`）；',
      '3. 认证失败（`AUTH_TOKEN_EXPIRED` / `USER_TOKEN_ILLEGAL` / `Token验证失败`）时，',
      '   不要反复重试，直接告诉用户在插件设置页点「登录钉钉」重新授权；',
      '4. 遇到「已知不支持」的能力，直接说明不支持并建议在钉钉客户端里操作，不要绕路。',
      '',
    ].join('\n')
  }

  /* ─────────────────────────── 工具注册 ─────────────────────────── */

  if (enabled) {
    ctx.tools.register(defineTool({
      name: 'dingtalk_dws',
      description: [
        '执行一条钉钉 Workspace CLI（dws）命令，操作钉钉里的真实业务数据：通讯录、日程会议、群聊与机器人消息、',
        'AI 表格、在线表格、钉钉文档、云盘、待办、OA 审批、考勤、日志、听记、邮箱、知识库。',
        '这是访问钉钉的**唯一**入口——不要用 bash/pwsh 调 dws，工具会自动补 `--format json` 并把结果解析成 JSON。',
        'service 放服务名与子命令（如 ["contact","user","get-self"]）；args 放 flags 与选项（kebab-case，值紧跟其后）；',
        '需要在子命令之前出现的东西（例如 `chat +send-text` 这类 shortcut，或看起来像 flag 的值）请放进 args。',
        '不确定命令或参数时，先用 args 传 `["<service>","--help"]` 查帮助再执行。',
        '禁止编造任何 ID（baseId/tableId/recordId/conversationId/processInstanceId/eventId），必须从命令返回里取。',
        '删除、撤回、拒绝审批、移除群成员、改权限等危险操作，必须先向用户展示操作摘要并取得明确同意，',
        '同意后才把 `--yes` 放进 args。',
      ].join(' '),
      parameters: {
        service: {
          type: 'array',
          items: { type: 'string' },
          description: '服务名与子命令，按顺序展开，例如 ["calendar","event","list"]。与 args 至少给一个。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'flags 与参数值，按顺序展开，例如 ["--start","2026-10-15","--end","2026-10-16"]。含 `+shortcut` 或形如 flag 的值时请放这里。',
        },
        description: {
          type: 'string',
          required: true,
          description: '这条命令做什么，5-15 个字，会显示在界面上，例如「列出今天的日程」。',
        },
        profile: {
          type: 'string',
          description: '本次命令使用的钉钉组织/账号（corpId:userId 这类稳定标识）。留空用当前账号。',
        },
        timeoutMs: {
          type: 'number',
          description: '超时毫秒数，默认取插件配置（60 秒），上限 15 分钟。批量或导出类命令可适当调大。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const result = value && typeof value === 'object' ? value : {}
          const lines = []
          if (result.ok === false) lines.push(`✗ ${result.code || '命令失败'}${result.message ? `：${result.message}` : ''}`)
          if (result.text) lines.push(result.text)
          if (!result.text && result.message) lines.push(result.message)
          if (result.extraText) lines.push(`--- 其它输出 ---\n${result.extraText}`)
          if (result.exitCode !== 0 && result.exitCode !== null) lines.push(`(退出码 ${result.exitCode})`)
          return [{ type: 'text', text: lines.join('\n\n') || '(无输出)' }]
        },
      },
      timeoutMs: 15 * 60 * 1000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const service = Array.isArray(args.service) ? args.service.map((part) => String(part)) : []
        const extras = Array.isArray(args.args) ? args.args.map((part) => String(part)) : []
        const argv = [...service, ...extras]
        if (argv.length === 0) throw new Error('service 与 args 至少要给一个，例如 ["contact","user","get-self"]')

        const containsFormat = argv.some((part) => part === '--format' || part === '-f' || part.startsWith('--format='))
        const serviceName = service[0] || extras[0] || ''

        if (serviceName === 'api' && config.exposeRawApi !== true) {
          throw new Error('`api`（裸 OpenAPI 调用）被插件策略禁用：请改用对应服务命令；确需开启时把配置 exposeRawApi 设为 true。')
        }
        if (argv.includes('--token')) {
          throw new Error('不允许通过工具传 `--token`：请让用户在插件设置页登录钉钉，不要在对话里传凭证。')
        }
        if (argv.includes('--client-secret') || argv.includes('--client-id')) {
          throw new Error('不允许通过工具覆盖 OAuth 客户端凭证，请在插件配置里设置。')
        }

        const finalArgs = [...argv]
        const requestedProfile = typeof args.profile === 'string' ? args.profile.trim() : ''
        if (requestedProfile && requestedProfile !== profileArg) {
          finalArgs.unshift('--profile', requestedProfile)
        }
        if (!containsFormat && serviceName !== 'help' && serviceName !== 'completion') {
          finalArgs.push('--format', 'json')
        }

        const started = Date.now()
        const result = await runDws(finalArgs, {
          timeoutMs: clampTimeout(args.timeoutMs, execTimeoutMs, 900_000),
          signal: exec.signal,
        })
        const parsed = interpret(result)
        log(`${result.exitCode === 0 ? 'ok' : 'fail'} ${result.command} (${Date.now() - started} ms)`)

        return {
          ok: parsed.ok,
          code: parsed.code,
          message: parsed.message,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          command: result.command,
          transport: result.transport,
          truncated: parsed.truncated,
          text: parsed.text,
          extraText: parsed.extraText,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'dingtalk_auth_status',
      description: [
        '查询钉钉连接状态：CLI 是否可用、当前登录的是哪个组织与谁、登录态是否还有效。',
        '这个工具只读本地登录态，不发起业务请求，也不会自动刷新 token，可以放心随时调用。',
        '当用户问「钉钉连上了吗 / 我是谁 / 是哪个组织」，或某条 dingtalk_dws 命令报认证错误时先调它。',
      ].join(' '),
      parameters: {
        checkCli: {
          type: 'boolean',
          description: '是否顺带跑一次 `dws doctor` 做完整环境自检（默认 false；自检较慢且会访问网络）。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const result = value && typeof value === 'object' ? value : {}
          const lines = [
            `状态：${result.state || '未知'}`,
            result.corpName ? `组织：${result.corpName}` : '',
            result.userName ? `账号：${result.userName}` : '',
            result.message ? `说明：${result.message}` : '',
            result.binary ? `二进制：${result.binary}` : '',
            result.probe ? `\n自检：\n${result.probe}` : '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const snapshot = await readStatus({ signal: exec.signal })
        let probe = ''
        if (args.checkCli === true) {
          const result = await probeCli(exec.signal)
          probe = result.text
        }
        return { ...snapshot, probe }
      },
    }))
  }

  /* ─────────────────── 技能知识与提示词注入 ─────────────────── */

  if (enabled && config.registerSkill !== false && skills?.registerProvider) {
    const providerName = 'dingtalk-dws'
    const summary = {
      name: 'dingtalk-dws',
      description: '通过钉钉官方 Workspace CLI（dws）操作钉钉：通讯录、日程、群聊与机器人、AI 表格、在线表格、'
        + '钉钉文档、云盘、待办、审批、考勤、日志、听记、邮箱、知识库。',
      whenToUse: '用户提到钉钉 / DingTalk，需要查同事或部门、看日程会议、发群消息、读写钉钉文档或云盘、'
        + '建待办、提或审审批、查考勤打卡、写日报周报、看会议纪要时。',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: providerName,
    }
    try {
      ctx.effect(() => skills.registerProvider(() => ({
        name: providerName,
        async list() {
          return { candidates: [{ ...summary, rank: 100, locator: { kind: 'inline' } }], complete: true }
        },
        async get() {
          return { ...summary, content: bundledSkillContent() }
        },
      })), 'dingtalk-dws: skill provider')
      log('已注册 dingtalk-dws 技能')
    } catch (error) {
      warn(`注册技能失败：${String(error?.message || error)}`)
    }
  }

  if (enabled && systemPrompt?.section) {
    try {
      ctx.effect(() => systemPrompt.section({
        name: 'dingtalk-dws',
        order: 900,
        text: [
          '## 钉钉',
          '',
          '本机通过钉钉官方 Workspace CLI（`dws`）连接钉钉。要读写钉钉数据，**只能**调用 `dingtalk_dws` 工具，',
          '不要用 `bash`/`pwsh` 去跑 `dws`：工具会补 `--format json`、解析 JSON、并强制危险操作的确认语义。',
          '不确定命令或参数时，先用 `dingtalk_dws` 传 `{"args":["<service>","--help"]}` 查看帮助。',
          '不要编造任何 ID，必须从命令返回里取。删除 / 撤回 / 拒绝审批 / 移除成员 / 改权限前必须先取得用户同意。',
          '连不上或报认证错误时，先调 `dingtalk_auth_status`，必要时让用户在插件设置页重新登录钉钉。',
        ].join('\n'),
      }), 'dingtalk-dws: prompt section')
    } catch (error) {
      warn(`注入提示词失败：${String(error?.message || error)}`)
    }
  }

  /* ─────────────────────── 设置页 HTTP 接口 ─────────────────────── */

  if (!webServer?.register) {
    state.webRouteError = webServer ? 'webServer 没有 register 方法' : 'apply 时 ctx.get("webServer") 为空'
    warn(`设置页路由未注册：${state.webRouteError}`)
  }

  if (enabled && webServer?.register) {
    /**
     * 统一的连接围栏 + JSON 响应助手。
     * @param {import('node:http').IncomingMessage} request 请求。
     * @param {import('node:http').ServerResponse} response 响应。
     * @param {string} method 允许的方法。
     * @returns {boolean} 是否继续处理。
     */
    function guard(request, response, method) {
      const rejection = connection?.requestRejection?.({ headers: request.headers })
      if (rejection) {
        response.writeHead(rejection)
        response.end()
        return false
      }
      if (request.method !== method) {
        sendJson(response, 405, { error: `请用 ${method}` })
        return false
      }
      return true
    }

    /**
     * 写一个 JSON 响应。
     * @param {import('node:http').ServerResponse} response 响应对象。
     * @param {number} status HTTP 状态码。
     * @param {unknown} payload 响应体。
     * @returns {void}
     */
    function sendJson(response, status, payload) {
      const body = JSON.stringify(payload ?? null)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(body)
    }

    /**
     * 读取并限制请求体大小。
     * @param {import('node:http').IncomingMessage} request 请求。
     * @returns {Promise<any>} 解析后的 JSON 体。
     */
    async function readBody(request) {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 64 * 1024) throw new Error('请求体过大')
        chunks.push(chunk)
      }
      if (size === 0) return {}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    ctx.effect(() => {
      const disposers = []
      state.webRouteError = ''

      disposers.push(webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: (request, response) => {
          if (!guard(request, response, 'GET')) return
          void (async () => {
            try {
              const url = new URL(request.url || '/', 'http://localhost')
              const force = url.searchParams.get('fresh') === '1'
              const status = await readStatus({ force })
              sendJson(response, 200, { ...status, pollMs: STATUS_POLL_MS, login: loginSnapshot() })
            } catch (error) {
              sendJson(response, 200, { state: 'error', message: String(error?.message || error) })
            }
          })()
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/cli-status`,
        handler: (request, response) => {
          if (!guard(request, response, 'GET')) return
          void (async () => {
            const result = await probeCli()
            sendJson(response, 200, { ok: result.ok, text: result.text, detail: result.detail ?? null })
          })()
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/login`,
        handler: (request, response) => {
          if (!guard(request, response, 'POST')) return
          void (async () => {
            try {
              const started = await startLogin()
              sendJson(response, 200, { ok: true, ...started })
            } catch (error) {
              sendJson(response, 400, { ok: false, error: String(error?.message || error) })
            }
          })()
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/logout`,
        handler: (request, response) => {
          if (!guard(request, response, 'POST')) return
          void (async () => {
            try {
              const body = await readBody(request)
              if (body.confirm !== true) throw new Error('退出登录需要确认（confirm: true）')
              loginError = ''
              const result = await runDws(['auth', 'logout'], { timeoutMs: LOGOUT_TIMEOUT_MS })
              const parsed = interpret(result)
              statusCache = { at: 0, value: undefined }
              const status = await readStatus({ force: true })
              sendJson(response, parsed.ok ? 200 : 400, {
                ok: parsed.ok,
                message: parsed.message || (parsed.ok ? '已退出登录' : '退出登录失败'),
                status,
              })
            } catch (error) {
              sendJson(response, 400, { ok: false, error: String((error && error.message) || error) })
            }
          })()
        },
      }))

      return () => { for (const dispose of disposers) dispose() }
    })
    state.webRoutesRegistered = 4

    /**
     * 登录进度的只读快照。
     * @returns {{ running: boolean, url: string, startedAt: number, error: string }} 登录快照。
     */
    function loginSnapshot() {
      return { running: loginProcess !== null, url: loginUrl, startedAt: loginStartedAt, error: loginError }
    }

    /**
     * 启动 `dws auth login --no-browser --recommend`，从输出里抓授权 URL 交给用户。
     *
     * 认证完成后 dws 会自己换到 token；这里只负责把 URL 呈现出来，并在进程结束时复查状态。
     *
     * @returns {Promise<{ url: string, note: string }>} 授权链接与说明。
     */
    async function startLogin() {
      if (loginProcess) return { url: loginUrl, note: '已有一次登录正在进行，请在下单页完成授权' }
      loginUrl = ''
      loginError = ''
      loginStartedAt = Date.now()

      const handle = await runDws(['auth', 'login', '--no-browser', '--recommend'], {
        timeoutMs: LOGIN_TIMEOUT_MS,
        detached: true,
        onOutput: (chunk) => {
          if (loginUrl) return
          const url = firstHttpUrl(chunk)
          if (url) {
            loginUrl = url
            log('已取得登录授权链接')
          }
        },
      })

      loginProcess = handle
      void handle.done.then(() => {
        loginProcess = null
        statusCache = { at: 0, value: undefined }
        if (!loginUrl) loginError = '登录进程结束但没有拿到授权链接，请查看 dws 日志或重试'
        log('登录进程已结束，已清除状态缓存')
      }).catch((error) => {
        loginProcess = null
        loginError = String(error?.message || error)
        statusCache = { at: 0, value: undefined }
      })

      // 等一小会儿让 CLI 把授权信息打到 stderr，这样界面能一次拿到链接。
      const deadline = Date.now() + 6000
      while (!loginUrl && loginProcess && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      if (loginUrl) return { url: loginUrl, note: '请在浏览器打开这个链接完成钉钉授权（5 分钟内有效）' }
      if (loginError) throw new Error(loginError)
      return { url: '', note: '登录已启动，但暂未取到链接；请稍后刷新状态，或查看 dws 日志' }
    }
  }

  log(enabled
    ? `已启用（工具：dingtalk_dws、dingtalk_auth_status；设置页：${webServer ? ROUTE_PREFIX : '不可用'}）`
    : '已在配置里关闭')
}
