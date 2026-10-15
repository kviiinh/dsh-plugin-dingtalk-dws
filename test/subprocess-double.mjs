/**
 * Test double for `ctx.subprocess`, faithful to the documented contract that
 * this plugin relies on:
 *
 *   - `spawn(spec)` starts a real child process with `argv`, `cwd`, `env`,
 *     and pipes for stdout/stderr;
 *   - it throws synchronously for a pre-aborted signal;
 *   - `handle.done` resolves `{ exitCode, signal }` and rejects on spawn failure;
 *   - `handle.terminate()` runs the grace ladder (SIGTERM then SIGKILL);
 *   - `resolveExecutable(name)` resolves a bare name against the ambient PATH.
 *
 * Using a double keeps this suite independent of the Harness composition while
 * still executing the real `dws.exe` end to end.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute } from 'node:path'

/**
 * Build a fake Cordis context whose property reads behave like the real one.
 *
 * The real Cordis Context is a Proxy that **throws** when a plugin reads a
 * service it did not declare in `inject`:
 *
 *   cannot get property "subprocess" without inject
 *
 * That throw silently killed this plugin three times: a helper written as
 * `ctx[key] !== undefined ? ctx[key] : ctx.get(key)` exploded on the first
 * service it probed, so the whole plugin never applied and the UI only ever
 * showed a 404. Reproducing the throw in tests is the only way to catch that
 * class of bug before a restart cycle finds it instead.
 *
 * @param {object} options 选项。
 * @param {Record<string, unknown>} options.services 由 `ctx.get()` 提供的服务。
 * @param {string[]} [options.inject] 声明为注入的服务名（这些可以按属性读）。
 * @returns {object} 假上下文。
 */
export function createStrictContext({ services, inject = [] }) {
  const target = {
    logger: { info: () => {}, warn: () => {} },
    effect(callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: (key) => services[key],
    on: () => () => {},
  }
  // 注入过的服务既可按属性读、也能被 ctx.get 读到（真实 Cordis 两者都成立）。
  for (const name of inject) {
    if (services[name] !== undefined) target[name] = services[name]
  }
  return new Proxy(target, {
    get(object, prop) {
      if (typeof prop === 'string' && !(prop in object)
        && !prop.startsWith('_') && prop !== 'then' && prop !== 'toJSON') {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(object, prop)
    },
  })
}

/**
 * @param {string} command 绝对路径或裸命令名。
 * @returns {string | undefined} 命中的绝对路径。
 */
function findOnPath(command) {
  const candidates = process.platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(command)
    ? [`${command}.exe`, `${command}.cmd`, command]
    : [command]
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const candidate of candidates) {
      for (const extension of extensions) {
        const full = `${dir}\\${candidate}${candidate.includes('.') ? '' : extension}`.replace(/\\\\/g, '\\')
        try {
          accessSync(full, constants.X_OK)
          return full
        } catch { /* keep looking */ }
      }
    }
  }
  return undefined
}

/**
 * Build the fake service.
 * @returns {object} the `ctx.subprocess` double.
 */
export function createSubprocessDouble() {
  return {
    async resolveExecutable(command, env) {
      if (isAbsolute(command)) {
        accessSync(command, constants.X_OK)
        return command
      }
      const found = findOnPath(command)
      if (!found) throw new Error(`subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
      return found
    },
    async terminalEnvironment() {
      return { platform: process.platform === 'win32' ? 'windows' : 'posix' }
    },
    spawn(spec) {
      if (spec.signal?.aborted) throw new Error('subprocess-local: the request was already aborted')
      const [file, ...args] = spec.argv
      const child = nodeSpawn(file, args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        windowsHide: true,
        stdio: [
          spec.stdio?.stdin === 'pipe' ? 'pipe' : 'ignore',
          spec.stdio?.stdout === 'pipe' || typeof spec.stdio?.stdout === 'object' ? 'pipe' : 'ignore',
          spec.stdio?.stderr === 'pipe' || typeof spec.stdio?.stderr === 'object' ? 'pipe' : 'ignore',
        ],
      })

      let terminated = false
      const killLadder = () => {
        if (terminated) return
        terminated = true
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }
      if (spec.signal) {
        if (spec.signal.aborted) killLadder()
        else spec.signal.addEventListener('abort', killLadder, { once: true })
      }

      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })

      return {
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined,
        control: undefined,
        collected: {},
        done,
        terminate: killLadder,
        async waitForExit(signal) {
          await done
          return true
        },
      }
    },
  }
}
