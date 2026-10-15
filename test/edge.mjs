/**
 * 边界自检：非 JSON 输出、超时、坏参数。
 *
 * 覆盖一个真实的坑：`dws <service> --help` 输出的是**纯文本**（不是 JSON），
 * 退出码 0。插件必须把它当成成功并把正文给模型，而不是报「命令失败」。
 *
 * 用法：node test/edge.mjs
 */
import { apply, Config } from '../index.js'
import { createSubprocessDouble } from './subprocess-double.mjs'

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
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`)
}

const tools = []
const services = new Map([['subprocess', createSubprocessDouble()]])
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  get: (key) => services.get(key),
  effect: (callback) => { callback(); return () => {} },
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
}

apply(ctx, Config({}))
const dws = tools.find((tool) => tool.name === 'dingtalk_dws')
const signal = new AbortController().signal

console.log('\n== 纯文本输出（--help）==')
const help = await dws.execute({ args: ['contact', '--help'], description: '列出通讯录子命令' }, { signal, callId: 'e1' })
check('help 判定为成功', help.ok === true, help)
check('help 保留了正文', typeof help.extraText === 'string' && help.extraText.includes('contact'), help.extraText?.slice(0, 200))
check('help 没有 JSON 正文', help.text === '' || help.text === undefined, help.text?.slice(0, 120))
check('help 退出码为 0', help.exitCode === 0, help.exitCode)

const render = dws.output.render({}, help)
const rendered = render.map((block) => block.text).join('\n')
check('渲染结果里有服务名', rendered.includes('contact'), rendered.slice(0, 200))
check('渲染结果不含「命令失败」', !rendered.includes('命令失败'), rendered.slice(0, 120))

console.log('\n== 坏参数（应为失败）==')
const bad = await dws.execute({ service: ['contact', 'no-such-command'], description: '故意打错' }, { signal, callId: 'e2' })
check('坏命令判定为失败', bad.ok === false, bad)
check('坏命令带退出码', bad.exitCode !== 0, bad.exitCode)
check('坏命令有可读消息', typeof bad.message === 'string' && bad.message.length > 0, bad.message)

console.log('\n== 空参数 ==')
try {
  await dws.execute({ description: '什么都没给' }, { signal, callId: 'e3' })
  check('空参数被拒绝', false, '没有抛错')
} catch (error) {
  check('空参数被拒绝', /至少要给一个/.test(error.message), error.message)
}

console.log('\n== 凭证与旁路拒绝 ==')
for (const [label, args, pattern] of [
  ['--token', { args: ['auth', 'login', '--token', 'xxx'], description: 'x' }, /--token/],
  ['--client-secret', { args: ['contact', 'user', 'get-self', '--client-secret', 'x'], description: 'x' }, /凭证/],
  ['api', { service: ['api'], description: 'x' }, /api/],
]) {
  try {
    await dws.execute(args, { signal, callId: 'e4' })
    check(`拒绝 ${label}`, false, '没有抛错')
  } catch (error) {
    check(`拒绝 ${label}`, pattern.test(error.message), error.message)
  }
}

console.log('\n== 超时 ==')
const started = Date.now()
const timed = await dws.execute(
  { service: ['profile', 'list'], description: '超时测试', timeoutMs: 1 },
  { signal, callId: 'e5' },
)
const elapsed = Date.now() - started
check('超时被标记', timed.timedOut === true, timed)
check('超时后确实终止了', elapsed < 20000, elapsed)
check('超时有可读原因', typeof timed.message === 'string' && timed.message.includes('超时'), timed.message)

console.log(`\n结果：${checks - failures}/${checks} 通过`)
process.exit(failures === 0 ? 0 : 1)
