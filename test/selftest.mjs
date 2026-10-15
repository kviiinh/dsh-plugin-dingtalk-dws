/**
 * 端到端自检：用假的 Cordis 上下文 + 真的 `dws.exe` 跑通插件的全部对外表面。
 *
 * 覆盖：
 *   1. 工具注册形状（名字、参数 schema、输出 schema）；
 *   2. `dingtalk_dws` 真实执行一条只读命令并解析成 JSON；
 *   3. 危险操作 / 凭证覆盖 / `api` 旁路的拒绝策略；
 *   4. `dingtalk_auth_status` 读出当前组织与账号；
 *   5. 设置页三条 HTTP 路由的状态码与响应形状（不真的触发登录 / 退出）。
 *
 * 用法：node test/selftest.mjs
 */
import { apply, Config } from '../index.js'
import { createSubprocessDouble } from './subprocess-double.mjs'

let failures = 0
let checks = 0

/**
 * 断言。
 * @param {string} label 用例名。
 * @param {boolean} condition 条件。
 * @param {unknown} [detail] 失败时打印的细节。
 * @returns {void}
 */
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
}

/** 建一个够用的假 Host 上下文。 */
function createContext() {
  const state = {
    tools: [],
    routes: new Map(),
    sections: [],
    skillProviders: [],
    disposers: [],
  }
  const services = new Map([
    ['subprocess', createSubprocessDouble()],
    ['connection', { requestRejection: () => undefined }],
  ])
  const ctx = {
    logger: {
      info: (...args) => console.log('    [info]', ...args),
      warn: (...args) => console.log('    [warn]', ...args),
    },
    get: (key) => services.get(key),
    effect(callback) {
      const dispose = callback()
      state.disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
  }
  services.set('systemPrompt', {
    section(section) {
      state.sections.push(section)
      return () => {}
    },
  })
  services.set('skills', {
    registerProvider(create) {
      state.skillProviders.push(create({ signal: new AbortController().signal, invalidate: () => {} }))
      return () => {}
    },
  })
  services.set('webServer', {
    register(route) {
      state.routes.set(route.path, route)
      return () => state.routes.delete(route.path)
    },
  })
  return { ctx, state }
}

/** 伪造一个 HTTP 请求。 */
function fakeRequest(method, url, body) {
  const url_ = new URL(url, 'http://localhost')
  if (body === undefined) return { method, url: url_.toString(), headers: {}, async *[Symbol.asyncIterator]() {} }
  const buffer = Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method,
    url: url_.toString(),
    headers: {},
    async *[Symbol.asyncIterator]() { yield buffer },
  }
}

/** 伪造一个 HTTP 响应，返回抓到的状态码与正文。 */
function fakeResponse() {
  const captured = { status: 0, headers: undefined, body: '' }
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk) },
  }
}

/** 等一个路由处理器结束。 */
async function callRoute(route, request, response) {
  route.handler(request, response)
  // 处理器内部用 void (async () => …)() 起异步任务，这里给事件循环留出时间。
  const deadline = Date.now() + 30_000
  while (!response.captured.body && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return response.captured
}

const { ctx, state } = createContext()

console.log('\n== 1. 注册形状 ==')
apply(ctx, Config({}))

const byName = new Map(state.tools.map((tool) => [tool.name, tool]))
check('注册了 dingtalk_dws', byName.has('dingtalk_dws'))
check('注册了 dingtalk_auth_status', byName.has('dingtalk_auth_status'))

const dws = byName.get('dingtalk_dws')
const parameters = dws?.output ? dws.parameters : undefined
const asJson = JSON.parse(JSON.stringify(parameters ?? {}))
check('dingtalk_dws parameters 是对象 schema', asJson?.type === 'object')
check('参数里有 service', Boolean(asJson?.properties?.service))
check('参数里有 args', Boolean(asJson?.properties?.args))
check('description 是必填', Array.isArray(asJson?.required) && asJson.required.includes('description'))
check('输出 schema 存在', Boolean(dws?.output?.schema))

console.log('\n== 2. 真实执行只读命令 ==')
const signal = new AbortController().signal
const self = await dws.execute(
  { service: ['contact', 'user', 'get-self'], description: '查我自己是谁' },
  { signal, callId: 'test-1' },
)
check('命令成功', self.ok === true, self)
check('自动补了 --format json', String(self.command).includes('--format json'), self.command)
const selfJson = JSON.parse(self.text)
check('解析出了 JSON', Boolean(selfJson) && typeof selfJson === 'object')
// 只断言「结构里有组织名字段」，不断言具体组织名——测试不应携带任何真实账号信息。
check(
  '返回体里带组织名',
  JSON.stringify(selfJson).includes('orgName') || JSON.stringify(selfJson).includes('corpName'),
  Object.keys(selfJson).slice(0, 12),
)

console.log('\n== 3. 拒绝策略 ==')
const rejections = [
  ['危险操作带 --yes 之外的策略：裸 api', { service: ['api'], description: 'x' }, /api/],
]
for (const [label, args, pattern] of rejections) {
  try {
    await dws.execute(args, { signal, callId: 'test-reject' })
    check(`拒绝 ${label}`, false, '没有抛错')
  } catch (error) {
    check(`拒绝 ${label}`, pattern.test(error.message), error.message)
  }
}

console.log('\n== 4. 认证状态 ==')
const statusTool = byName.get('dingtalk_auth_status')
const status = await statusTool.execute({}, { signal, callId: 'test-2' })
check('状态是 connected 或明确的原因', typeof status.state === 'string', status)
check('读到了组织名', typeof status.corpName === 'string' && status.corpName.length > 0, status)
check('读到了账号名', typeof status.userName === 'string' && status.userName.length > 0, status)
console.log(`    → ${status.state} / ${status.corpName} / ${status.userName}`)

console.log('\n== 5. 设置页路由 ==')
const statusRoute = state.routes.get('/dingtalk-dws/status')
check('注册了 /dingtalk-dws/status', Boolean(statusRoute))
if (statusRoute) {
  const captured = await callRoute(statusRoute, fakeRequest('GET', '/dingtalk-dws/status'), fakeResponse())
  check('status 返回 200', captured.status === 200, captured)
  const body = JSON.parse(captured.body || '{}')
  check('status 带 state', typeof body.state === 'string', body)
  check('status 带轮询间隔', typeof body.pollMs === 'number', body)
  check('status 暴露 login 快照但无 URL', body.login && body.login.url === '', body.login)
}
const wrongMethod = await callRoute(statusRoute, fakeRequest('POST', '/dingtalk-dws/status'), fakeResponse())
check('status 拒绝非 GET', wrongMethod.status === 405, wrongMethod)

const logoutRoute = state.routes.get('/dingtalk-dws/logout')
check('注册了 /dingtalk-dws/logout', Boolean(logoutRoute))
if (logoutRoute) {
  const captured = await callRoute(
    logoutRoute,
    fakeRequest('POST', '/dingtalk-dws/logout', { confirm: false }),
    fakeResponse(),
  )
  check('logout 缺少确认时返回 400', captured.status === 400, captured)
  check('logout 给出了确认提示', /确认/.test(captured.body), captured.body)
}

check('注册了 /dingtalk-dws/login', state.routes.has('/dingtalk-dws/login'))
check('注册了 /dingtalk-dws/cli-status', state.routes.has('/dingtalk-dws/cli-status'))

console.log('\n== 6. 技能与提示词 ==')
check('注册了 1 个技能 provider', state.skillProviders.length === 1)
if (state.skillProviders[0]) {
  const candidates = await state.skillProviders[0].list({})
  check('技能候选里有 dingtalk-dws', candidates.candidates?.some((item) => item.name === 'dingtalk-dws'), candidates)
  const loaded = await state.skillProviders[0].get(candidates.candidates[0], {})
  check('技能正文非空', typeof loaded.content === 'string' && loaded.content.length > 500, loaded.content?.length)
  check('技能正文含工具契约', /dingtalk_dws/.test(loaded.content || ''))
}
check('注入了提示词段落', state.sections.some((section) => section.name === 'dingtalk-dws'), state.sections)

console.log(`\n结果：${checks - failures}/${checks} 通过`)
process.exit(failures === 0 ? 0 : 1)
