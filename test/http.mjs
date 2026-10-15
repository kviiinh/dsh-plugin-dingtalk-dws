/**
 * 真实 HTTP 集成自检。
 *
 * 前两轮我把「路由注册成功」当成理所当然，结果界面上一直是 404 —— 根因是
 * 插件在 `webServer` 就绪前就 apply 了，`ctx.get('webServer')` 是空的，
 * 整段路由注册被 `if` 静默跳过。单元测试用假上下文抓不到这个问题。
 *
 * 这个套件用**真的 HTTP 请求**打上去验证：路由真的在、路径真的对、状态码真的是 200。
 *
 * 用法：node test/http.mjs
 */
import { apply, Config, inject } from '../index.js'
import { createSubprocessDouble, createStrictContext } from './subprocess-double.mjs'
import { createWebServerDouble } from './webserver-double.mjs'

let failures = 0
let checks = 0

/**
 * 断言。
 * @param {string} label 用例名。
 * @param {boolean} condition 条件。
 * @param {unknown} [detail] 失败细节。
 * @returns {void}
 */
function check(label, condition, detail) {
  checks += 1
  if (condition) { console.log(`  ok   ${label}`); return }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
}

const web = await createWebServerDouble()
const tools = []
const services = new Map([
  ['subprocess', createSubprocessDouble()],
  ['connection', { requestRejection: () => undefined }],
])
// 模拟「webServer 已经就绪」的上下文：属性直接可读，与 Cordis 注入后的样子一致。
const ctx = {
  logger: { info: () => {}, warn: (m) => console.log('    [warn]', m) },
  webServer: web.service,
  connection: services.get('connection'),
  subprocess: services.get('subprocess'),
  get: (key) => services.get(key),
  effect: (callback) => { callback(); return () => {} },
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
}

console.log('\n== 注册 ==')
console.log(`  inject: ${JSON.stringify(inject)}`)
apply(ctx, Config({}))

check('注册了 dingtalk_dws', tools.some((tool) => tool.name === 'dingtalk_dws'))
const routes = web.service.routes()
console.log(`  已注册精确路由: ${JSON.stringify(routes.exact)}`)
check('注册了 4 条精确路由', routes.exact.length === 4, routes)
for (const path of ['/dingtalk-dws/status', '/dingtalk-dws/cli-status', '/dingtalk-dws/login', '/dingtalk-dws/logout']) {
  check(`路由存在 ${path}`, routes.exact.includes(path))
}

console.log('\n== 真实 HTTP 请求 ==')

/**
 * 发一个真实请求。
 * @param {string} path 路径。
 * @param {RequestInit} [init] 选项。
 * @returns {Promise<{ status: number, body: any, raw: string }>} 响应。
 */
async function request(path, init) {
  const response = await fetch(`${web.url}${path}`, init)
  const raw = await response.text()
  let body
  try { body = JSON.parse(raw) } catch { body = undefined }
  return { status: response.status, body, raw }
}

const status = await request('/dingtalk-dws/status')
check('GET /dingtalk-dws/status 返回 200', status.status === 200, { status: status.status, raw: status.raw.slice(0, 200) })
check('状态里带 state', typeof status.body?.state === 'string', status.body)
check('状态里带 pollMs', typeof status.body?.pollMs === 'number', status.body)
check('状态里带 login 快照', typeof status.body?.login === 'object', status.body?.login)
// 只断言「连上了并读到了账号信息」，不打印也不断言任何真实组织 / 账号值。
console.log(`  → state=${status.body?.state} 组织字段=${typeof status.body?.corpName} 账号字段=${typeof status.body?.userName}`)
check('读到了组织名', typeof status.body?.corpName === 'string' && status.body.corpName.length > 0)
check('读到了账号名', typeof status.body?.userName === 'string' && status.body.userName.length > 0)

const wrongMethod = await request('/dingtalk-dws/status', { method: 'POST' })
check('POST /status 返回 405', wrongMethod.status === 405, wrongMethod.status)

const logoutNoConfirm = await request('/dingtalk-dws/logout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
})
check('logout 缺确认返回 400', logoutNoConfirm.status === 400, logoutNoConfirm.raw.slice(0, 200))
check('logout 提示要确认', /确认/.test(logoutNoConfirm.raw), logoutNoConfirm.raw.slice(0, 200))

const missing = await request('/dingtalk-dws/nope')
check('未知子路径走 fallback（404）', missing.status === 404, missing.status)

console.log('\n== subprocess 缺失时的退路 ==')
// 根 scope 上 subprocess 不是可注入服务（实测），所以插件必须能在没有它时工作。
// 用一台新的 webServer double：真实 WebServer 对重复路由会直接抛错。
const web2 = await createWebServerDouble()
const tools2 = []
const ctxNoSub = {
  logger: { info: () => {}, warn: () => {} },
  webServer: web2.service,
  connection: services.get('connection'),
  get: () => undefined,
  effect: (callback) => { callback(); return () => {} },
  tools: { register: (definition) => { tools2.push(definition); return () => {} } },
}
apply(ctxNoSub, Config({}))
const dws = tools2.find((tool) => tool.name === 'dingtalk_dws')
const executed = await dws.execute(
  { service: ['contact', 'user', 'get-self'], description: '查我自己是谁' },
  { signal: new AbortController().signal, callId: 'http-test' },
)
check('没有 ctx.subprocess 也能跑 dws', executed.ok === true, executed)
check('走的是 Node 原生进程', executed.transport === 'node:child_process', executed.transport)
await web2.close()

console.log('\n== 严格上下文：复刻 Cordis 的 inject 抛错 ==')
// 这是前三轮失败的真正原因：读一个没 inject 的服务属性会抛
// `cannot get property "X" without inject`，把整个插件炸掉。
// 用会抛错的假上下文，确保 apply 再也不会在这里静默死掉。
const web3 = await createWebServerDouble()
const strictTools = []
const strictCtx = createStrictContext({
  inject,
  services: {
    tools: { register: (definition) => { strictTools.push(definition); return () => {} } },
    webServer: web3.service,
    connection: { requestRejection: () => undefined },
    // subprocess / skills / systemPrompt 刻意不提供：插件必须能在缺少它们时活着并且工作。
  },
})
let strictError = ''
try {
  apply(strictCtx, Config({}))
} catch (error) {
  strictError = String(error?.message || error)
}
check('严格上下文下 apply 不抛错', strictError === '', strictError)
check('严格上下文下注册了工具', strictTools.some((tool) => tool.name === 'dingtalk_dws'), strictTools.map((t) => t.name))
check('严格上下文下注册了路由', web3.service.routes().exact.length === 4, web3.service.routes())
if (strictTools.length > 0 && strictError === '') {
  const strictDws = strictTools.find((tool) => tool.name === 'dingtalk_dws')
  const strictRun = await strictDws.execute(
    { service: ['contact', 'user', 'get-self'], description: '严格上下文下查自己' },
    { signal: new AbortController().signal, callId: 'strict' },
  )
  check('严格上下文下工具能真的跑通', strictRun.ok === true, strictRun)
}
await web3.close()

await web.close()
console.log(`\n结果：${checks - failures}/${checks} 通过`)
process.exit(failures === 0 ? 0 : 1)
