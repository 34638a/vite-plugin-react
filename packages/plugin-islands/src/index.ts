import path from 'node:path'
/**
 * @vitejs/plugin-islands
 *
 * Splits a React codebase along the `"use client"` boundary, reusing the
 * directive detection and export-rewriting transforms from
 * `@vitejs/plugin-rsc`, but WITHOUT React Server Components / Flight:
 *
 *   module kind          server (SSR) build                 client build
 *   ------------------   --------------------------------   --------------------------
 *   no directive         rendered to static HTML            not bundled (unless an
 *                                                           island imports it)
 *   "use client"         rendered to HTML *and* wrapped     bundled as its own chunk,
 *                        in a <vite-island> marker          listed in the registry
 *   "use server"         untouched (server only)            build ERROR (see below)
 *
 * The browser entry (`main.js`) only needs:
 *
 *     import 'virtual:islands/client'
 *
 * which loads the registry and hydrates every marker found in the page.
 *
 * ### About `"use server"`
 * In React, `"use server"` marks server *actions* (functions callable from the
 * browser over RPC), not "components that render on the server". Components
 * that render on the server need no directive at all. Since a static-HTML
 * deployment has no action endpoint, a `"use server"` module reaching the
 * client build is always a mistake (it would either leak server code or
 * produce calls to a non-existent endpoint), so we fail the build loudly.
 */
import {
  findDirectives,
  hasDirective,
  transformWrapExport,
} from '@vitejs/plugin-rsc/transforms'
import {
  parseAstAsync,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite'
import { islandId, scanIslands } from './scan'

export interface IslandsOptions {
  /**
   * Globs (relative to the Vite root) searched for `"use client"` modules.
   * Only matched files can hydrate: the client registry is built from this
   * scan so the client build never depends on SSR build order.
   * @default ['src/**\/*.{js,jsx,ts,tsx}']
   */
  include?: string[]
  /** @default ['**\/node_modules/**', '**\/*.d.ts', '**\/*.test.*', '**\/*.spec.*'] */
  exclude?: string[]
  /**
   * Return `true` for islands that must NOT be server-rendered (e.g. they read
   * `window` while rendering). The marker is still emitted but empty, and the
   * browser renders it from scratch instead of hydrating.
   * @param file absolute path of the `"use client"` module
   */
  clientOnly?: (file: string) => boolean
}

const PKG = '@vitejs/plugin-islands'
const VIRTUAL_REGISTRY = 'virtual:islands/registry'
const VIRTUAL_CLIENT = 'virtual:islands/client'
const RESOLVED = (id: string) => '\0' + id

/** Removes `?v=hash` / `?import` style queries that Vite appends in dev. */
const cleanUrl = (id: string) => id.replace(/[?#].*$/s, '')

export function islands(options: IslandsOptions = {}): Plugin[] {
  const include = options.include ?? ['src/**/*.{js,jsx,ts,tsx}']
  const exclude = options.exclude ?? [
    '**/node_modules/**',
    '**/*.d.ts',
    '**/*.test.*',
    '**/*.spec.*',
  ]

  let config: ResolvedConfig
  let server: ViteDevServer | undefined
  /** island id -> absolute module path; the single source of truth. */
  let registry = new Map<string, string>()
  let scanned: Promise<void> | undefined

  const rescan = () =>
    (scanned = scanIslands({ root: config.root, include, exclude }).then(
      (m) => {
        registry = m
      },
    ))
  const ensureScanned = () => scanned ?? rescan()

  /** Generates the `id -> dynamic import` table for the browser. */
  function registryModule(): string {
    const rows = [...registry].map(([id, file]) => {
      if (config.command === 'serve') {
        // Dev: a host that fronts Vite (e.g. a server that owns root-relative
        // URLs such as `/src/...`) would swallow the normalised import. `/@fs/`
        // is always Vite's own, but Vite only keeps it when the specifier is
        // not a literal it can analyse, hence the variable.
        const url = '/@fs/' + file.split(path.sep).join('/').replace(/^\//, '')
        return `  ${JSON.stringify(id)}: () => { const url = ${JSON.stringify(url)}; return import(/* @vite-ignore */ url) },`
      }
      // Build: root-relative specifier when possible: stable across machines
      // and resolved by Vite exactly like a hand-written import.
      const rel = path.relative(config.root, file).split(path.sep).join('/')
      const specifier = rel.startsWith('..') ? file : '/' + rel
      return `  ${JSON.stringify(id)}: () => import(${JSON.stringify(specifier)}),`
    })
    return `export default {\n${rows.join('\n')}\n}\n`
  }

  /** ESTree `Literal` types omit `start`, but oxc-parsed nodes always carry it. */
  const startOf = (node: object | undefined) =>
    (node as { start?: number } | undefined)?.start

  const isServer = (env: { config: { consumer: string } }) =>
    env.config.consumer === 'server'

  return [
    {
      name: 'islands:core',

      configEnvironment(name, env) {
        // The server runtime uses React context. If it were externalized while
        // the app is bundled (or vice versa) there would be two copies of
        // React and `useContext` would silently read the wrong one.
        if (name === 'ssr' || env.consumer === 'server') {
          return { resolve: { noExternal: [PKG] } }
        }
      },

      configResolved(resolved) {
        config = resolved
      },

      buildStart: ensureScanned,

      async configureServer(devServer) {
        server = devServer
        await ensureScanned()

        // Keep the registry current while developing. Adds/removes always
        // matter; edits only matter if the file gained/lost the directive.
        const refresh = async () => {
          const before = [...registry.keys()].join()
          await rescan()
          if ([...registry.keys()].join() === before) return
          for (const env of Object.values(server!.environments)) {
            const mod = env.moduleGraph.getModuleById(
              RESOLVED(VIRTUAL_REGISTRY),
            )
            if (mod) env.moduleGraph.invalidateModule(mod)
          }
          server!.hot.send({ type: 'full-reload' })
        }
        server.watcher.on('add', () => void refresh())
        server.watcher.on('unlink', () => void refresh())
        server.watcher.on('change', (file) => {
          // Cheap pre-filter: only re-scan when the edit could flip membership.
          if (/\.[jt]sx?$/.test(file)) void refresh()
        })
      },

      // --- virtual modules ----------------------------------------------
      resolveId: {
        filter: { id: /^virtual:islands\/(registry|client)$/ },
        handler(source) {
          return RESOLVED(source)
        },
      },
      async load(id) {
        if (id === RESOLVED(VIRTUAL_REGISTRY)) {
          await ensureScanned()
          return registryModule()
        }
        if (id === RESOLVED(VIRTUAL_CLIENT)) {
          // Side-effect entry: importing it is enough to hydrate the page.
          return [
            `import registry from ${JSON.stringify(VIRTUAL_REGISTRY)}`,
            `import { hydrateIslands } from ${JSON.stringify(PKG + '/runtime/client')}`,
            `export { hydrateIslands, registry }`,
            // Module scripts are deferred, so the DOM is already parsed;
            // the readyState check covers inline/async usage too.
            `if (document.readyState === 'loading') {`,
            `  document.addEventListener('DOMContentLoaded', () => hydrateIslands(registry), { once: true })`,
            `} else {`,
            `  hydrateIslands(registry)`,
            `}`,
          ].join('\n')
        }
      },
    },

    {
      // SERVER: "use client" modules keep their code (so SSR renders real
      // markup) but every component export is wrapped to emit the marker.
      name: 'islands:server-wrap',
      transform: {
        filter: { code: 'use client' },
        async handler(code, rawId) {
          if (!isServer(this.environment)) return
          if (rawId.startsWith('\0')) return
          const file = cleanUrl(rawId)

          const ast = await parseAstAsync(code)
          if (!hasDirective(ast.body, 'use client')) return

          const mixed = findDirectives(ast, 'use server')
          if (mixed.length > 0) {
            this.error(
              `'use server' directive is not allowed inside 'use client'`,
              startOf(mixed[0]),
            )
          }

          await ensureScanned()
          const id = islandId(config.root, file)
          if (!registry.has(id)) {
            this.warn(
              `"use client" module ${path.relative(config.root, file)} is not ` +
                `matched by the \`include\` option, so it has no client chunk ` +
                `and will NOT hydrate.`,
            )
          }

          const hydrate = !options.clientOnly?.(file)
          const result = transformWrapExport(code, ast, {
            runtime: (value, name) =>
              `$$islands.wrap(${value}, ${JSON.stringify(id)}, ${JSON.stringify(name)}, ${hydrate})`,
          })
          result.output.prepend(
            `import * as $$islands from ${JSON.stringify(PKG + '/runtime/server')};\n`,
          )
          return {
            code: result.output.toString(),
            map: result.output.generateMap({ hires: 'boundary', source: file }),
          }
        },
      },
    },

    {
      // CLIENT: server-only code must never reach the browser bundle.
      name: 'islands:client-guard',
      transform: {
        filter: { code: 'use server' },
        async handler(code, rawId) {
          if (isServer(this.environment)) return
          if (rawId.startsWith('\0')) return
          const ast = await parseAstAsync(code)
          const found = findDirectives(ast, 'use server')
          if (found.length === 0) return
          this.error(
            `"use server" module ${path.relative(config.root, cleanUrl(rawId))} ` +
              `was pulled into the client bundle (imported from a "use client" ` +
              `module?). Static islands have no server-action endpoint; keep ` +
              `server-only code out of client component imports.`,
            startOf(found[0]),
          )
        },
      },
    },
  ]
}

export default islands
