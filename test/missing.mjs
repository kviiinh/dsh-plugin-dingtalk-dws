/**
 * 回归测试：机器上**没有** `dws` 时，插件必须优雅降级，而不是崩或静默失败。
 *
 * 这是对「插件会不会自己装 dws」这个问题的固化回答：
 *
 *   - `dingtalk_dws`        抛一条可操作的中文错误；
 *   - `dingtalk_auth_status` 返回 `state: 'cli_missing'` + 可读提示；
 *   - 插件**不**做任何网络请求、不调用任何包管理器、不自我升级。
 *
 * 复现手法：把 `USERPROFILE` 指到一个空临时目录，并清掉 `DWS_CONFIG_DIR`，
 * 让插件的两个「用户目录」候选路径都落空；再给一个没有 `spawn`、
 * `resolveExecutable` 必抛的 subprocess 替身，让 PATH 兜底也失败。
 *
 * 用法：node test/missing.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../index.js'
import { createStrictContext } from './subprocess-double.mjs'
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
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`)
}

// 让候选路径全部落空，且不碰真实文件：插件是按环境变量实时计算的。
const emptyHome = fileURLToPath(new URL('./.empty-home/', import.meta.url))
process.env.USERPROFILE = emptyHome
delete process.env.DWS_CONFIG_DIR

const web = await createWebServerDouble()
const tools = []
const resolveCalls = []

const barrenSubprocess = {
  async resolveExecutable(command) {
    resolveCalls.push(command)
    throw new Error(`subprocess-local: command "${command}" was not found on PATH`)
  },
  // 刻意不提供 spawn：连一个能起进程的服务都没有。
}

const ctx = createStrictContext({
  inject: ['tools', 'webServer', 'connection'],
  services: {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    webServer: web.service,
    connection: { requestRejection: () => undefined },
    subprocess: barrenSubprocess,
  },
})

apply(ctx, Config({ executable: '' }))

const dws = tools.find((tool) => tool.name === 'dingtalk_dws')
const status = tools.find((tool) => tool.name === 'dingtalk_auth_status')
const signal = new AbortController().signal

console.log('\n== 1. 工具仍然注册了（插件不能因为没装 CLI 就整个不加载）==')
check('注册了 dingtalk_dws', Boolean(dws))
check('注册了 dingtalk_auth_status', Boolean(status))
check('注册了 4 条路由', web.service.routes().exact.length === 4, web.service.routes())

console.log('\n== 2. dingtalk_dws 给出可操作的错误 ==')
let thrown = ''
try {
  await dws.execute({ service: ['contact', 'user', 'get-self'], description: '查自己' }, { signal, callId: 'x' })
} catch (error) {
  thrown = String(error?.message || error)
}
check('抛错而不是静默失败', thrown.length > 0, thrown)
check('错误里点名了 dws', /dws/i.test(thrown), thrown)
check('错误里给了下一步（指定路径 / 放进 PATH）', /指定|PATH/i.test(thrown), thrown)

console.log('\n== 3. dingtalk_auth_status 降级为 cli_missing ==')
const snapshot = await status.execute({}, { signal, callId: 'y' })
check('state 是 cli_missing', snapshot.state === 'cli_missing', snapshot.state)
check('message 非空', typeof snapshot.message === 'string' && snapshot.message.length > 0, snapshot.message)
check('hint 非空', typeof snapshot.hint === 'string' && snapshot.hint.length > 0, snapshot.hint)

console.log('\n== 4. 确实尝试过解析二进制（不是提前放弃）==')
check('调用过 resolveExecutable', resolveCalls.length > 0, resolveCalls)

console.log('\n== 5. 插件不含任何「下载 / 安装 / 升级」动作 ==')
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
// 只查真正的代码调用形态；技能正文里那句「禁止 curl 旁路」是说明文字，不算。
const forbidden = [
  'node:https', "from 'node:http'", 'fetch(', 'npm install', 'pnpm add',
  'upgradeCli', 'downloadFile', 'https.get', 'child_process.exec',
]
for (const needle of forbidden) {
  check(`代码里没有 ${needle}`, !source.includes(needle))
}

await web.close()
console.log(`\n结果：${checks - failures}/${checks} 通过`)
process.exit(failures === 0 ? 0 : 1)
