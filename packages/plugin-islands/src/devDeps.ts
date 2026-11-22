import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Vite serves pre-bundled dependencies (`/node_modules/.vite/deps/x.js?v=hash`)
 * as `immutable` for a year. When the optimizer re-runs under the SAME hash (a
 * config change it does not hash, a forced re-optimize) a browser that already
 * has the old file keeps using it, and the page breaks in ways that point
 * nowhere near the cache (e.g. `$RefreshSig$ is not defined` from react-dom).
 *
 * In dev, ask the browser to revalidate those files instead: it costs a 304
 * from the local server per file.
 */
const DEPS = '/node_modules/.vite/deps/'

export function revalidateOptimizedDeps(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (req.url?.includes(DEPS)) {
    const setHeader = res.setHeader.bind(res)
    // Vite sets its Cache-Control as it sends the file, after this runs.
    res.setHeader = ((name: string, value: unknown) =>
      setHeader(
        name,
        name.toLowerCase() === 'cache-control' ? 'no-cache' : (value as string),
      )) as typeof res.setHeader
  }
  next()
}
