/**
 * Test double for `ctx.webServer`, faithful to the shipped implementation's
 * routing contract:
 *
 *   - `register({ kind, path, handler })` puts an `exact` route in an exact
 *     table and anything else in a prefix table;
 *   - `match(pathname)` tries the exact table first (a Map lookup on the raw
 *     pathname), then longest-prefix-wins over the prefix table;
 *   - there is exactly one fallback seat;
 *   - a request matching no route goes to the fallback, or gets a bare 404 when
 *     no fallback is registered.
 *
 * The double is a real HTTP listener, so a test can make a genuine request and
 * observe the status code a browser would see.
 */
import { createServer } from 'node:http'

/**
 * Start the double on an ephemeral loopback port.
 * @returns {Promise<{ service: object, port: number, url: string, close: () => Promise<void> }>} the running double.
 */
export async function createWebServerDouble() {
  const exact = new Map()
  const prefixes = new Map()
  let fallback

  const match = (pathname) => {
    const hit = exact.get(pathname)
    if (hit !== undefined) return hit
    let best
    for (const [prefix, route] of prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  const server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = match(rawPath)
    if (route !== undefined) {
      Promise.resolve(route.handler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
      return
    }
    if (fallback === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(fallback(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port

  const service = {
    /** @see WebServerService.register */
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    /** @see WebServerService.registerFallback */
    registerFallback(handler) {
      if (fallback !== undefined) throw new Error('webserver: fallback already registered')
      fallback = handler
      return () => { fallback = undefined }
    },
    /** @see WebServerService.match */
    match,
    /** Test-only inspection. */
    routes() {
      return { exact: [...exact.keys()], prefixes: [...prefixes.keys()] }
    },
  }

  return {
    service,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
