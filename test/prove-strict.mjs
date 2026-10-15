/**
 * 一次性证明：严格上下文能复刻 Cordis 的 inject 抛错。
 *
 * 这个检查存在的意义是验证「测试替身真的有牙齿」——如果替身不会抛，
 * 那么上面那条回归用例就是摆设。
 *
 * 用法：node test/prove-strict.mjs
 */
import { createStrictContext } from './subprocess-double.mjs'

const ctx = createStrictContext({ inject: ['tools'], services: { tools: {}, webServer: {} } })

// 复刻旧版 getService 的写法（就是它炸掉了整个插件）。
const oldGetService = (key) => (ctx[key] !== undefined ? ctx[key] : ctx.get?.(key))

let threw = ''
try {
  oldGetService('subprocess')
} catch (error) {
  threw = String(error?.message || error)
}

console.log(`旧写法 ctx['subprocess'] → ${threw || '(没有抛错)'}`)
console.log(`安全写法 ctx.get('subprocess') → ${JSON.stringify(ctx.get('subprocess'))}`)
console.log(`注入过的 ctx['tools'] → ${typeof ctx.tools}`)

if (!threw.includes('without inject')) {
  console.error('FAIL: 严格上下文没有复刻 Cordis 的抛错，回归用例是摆设')
  process.exit(1)
}
console.log('ok: 严格上下文确实复刻了 Cordis 的 inject 抛错')
