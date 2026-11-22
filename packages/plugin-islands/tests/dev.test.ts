import path from 'node:path'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { islands } from '../src/index'

const root = path.resolve(import.meta.dirname, 'fixture')

/** A dev server over the fixture, in middleware mode (nothing listens). */
async function devServer(extra: Plugin[] = []) {
  return createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [islands({ include: ['src/{Counter,Panel}.tsx'] }), ...extra],
  })
}

const load = async (server: ViteDevServer, id: string) =>
  (await server.environments.client.transformRequest(id))!.code

describe('dev registry', () => {
  let server: ViteDevServer
  beforeAll(async () => {
    server = await devServer()
  })
  afterAll(() => server.close())

  test('loads each island from a /@fs/ URL, which hosts that own /src/... cannot swallow', async () => {
    const code = await load(server, 'virtual:islands/registry')
    const fsRoot = root.split(path.sep).join('/')
    expect(code).toContain(`/@fs/${fsRoot}/src/Counter.tsx`)
    expect(code).toContain(`/@fs/${fsRoot}/src/Panel.tsx`)
    // A root-relative /src/... URL is what a host such as Stencil answers itself.
    expect(code).not.toMatch(/["']\/src\//)
    // Vite must not try to analyse (and normalise) the specifier.
    expect(code).toContain('/* @vite-ignore */')
  })

  test('has no build stamp: dev islands change under it, and one server makes both sides', async () => {
    expect(await load(server, 'virtual:islands/registry')).toContain(
      'export const build = null',
    )
  })

  test('the client entry installs no refresh preamble without plugin-react', async () => {
    const code = await load(server, 'virtual:islands/client')
    expect(code).not.toContain('preamble')
  })
})

describe('dev client entry with plugin-react present', () => {
  let server: ViteDevServer
  beforeAll(async () => {
    // Stands in for plugin-react's virtual preamble module.
    const react: Plugin = {
      name: 'vite:react-virtual-preamble',
      resolveId: (id) =>
        id === '@vitejs/plugin-react/preamble' ? '\0preamble' : null,
      load: (id) => (id === '\0preamble' ? '' : null),
    }
    server = await devServer([react])
  })
  afterAll(() => server.close())

  test('imports the refresh preamble before anything that loads react', async () => {
    const code = await load(server, 'virtual:islands/client')
    const preamble = code.indexOf('preamble')
    expect(preamble).toBeGreaterThanOrEqual(0)
    expect(preamble).toBeLessThan(code.indexOf('virtual:islands/registry'))
    expect(preamble).toBeLessThan(code.indexOf('runtime/client'))
  })
})

describe('build stamp on a production-mode server', () => {
  // The templates of an HBX theme render on a private dev-style server while
  // the production build runs, so production is not the same as `vite build`.
  test('is stamped when NODE_ENV is production, even on a dev-style server', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    let server: ViteDevServer | undefined
    try {
      server = await devServer()
      expect(await load(server, 'virtual:islands/registry')).toMatch(
        /export const build = "[0-9a-f]{8}"/,
      )
    } finally {
      await server?.close()
      process.env.NODE_ENV = previous
    }
  })
})
