import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
/**
 * End-to-end: build a fixture through BOTH pipelines, render it, and load the
 * result in a real browser to prove the islands actually hydrate.
 *
 * Requires `pnpm build` first (the fixture consumes the built runtimes, the
 * same way a real app would).
 */
import { chromium, type Browser } from '@playwright/test'
import { createBuilder, type InlineConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { islands } from '../src/index'

const root = path.resolve(import.meta.dirname, 'fixture')

/** Same shape a real consumer would write: SSR first, then client. */
function fixtureConfig(
  outDir: string,
  ssrEntry = 'src/entry-ssr.tsx',
  include?: string[],
): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      islands({
        ...(include ? { include } : {}),
        // These fixtures must render on the client (as a token prop would force).
        clientOnly: (file) => /(ClientCounter|Exploder)\.tsx$/.test(file),
      }),
    ],
    oxc: { jsx: { runtime: 'automatic' } },
    environments: {
      ssr: {
        build: {
          outDir: `${outDir}/ssr`,
          emptyOutDir: true,
          rollupOptions: { input: { entry: ssrEntry } },
        },
      },
      client: {
        build: {
          outDir: `${outDir}/client`,
          emptyOutDir: true,
          rollupOptions: {
            input: { main: 'src/main.js' },
            output: { entryFileNames: 'main.js' },
          },
        },
      },
    },
    builder: {
      async buildApp(builder) {
        await builder.build(builder.environments.ssr!)
        await builder.build(builder.environments.client!)
      },
    },
  }
}

describe('islands pipeline', () => {
  const outDir = 'dist'
  let html: string
  let fallbackHtml: string
  let server: http.Server
  let origin: string
  let browser: Browser

  beforeAll(async () => {
    // Only the good fixture files: BadIsland is exercised separately.
    const builder = await createBuilder(
      fixtureConfig(outDir, undefined, [
        'src/{Counter,Panel,Page,entry-ssr,ClientCounter,Exploder,FallbackPage}.tsx',
      ]),
    )
    await builder.buildApp()

    // Run the SSR bundle exactly like a custom renderer would.
    const ssr = await import(
      pathToFileURL(path.join(root, outDir, 'ssr/entry.js')).href
    )
    html = ssr.render()
    fallbackHtml = ssr.renderFallback()

    // Serve what Apache would: a static page + the client dist.
    const page = `<!doctype html><html><body><div id="app">${html}</div>
<script type="module" src="/main.js"></script></body></html>`
    server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html').end(page)
        return
      }
      if (req.url === '/fallback') {
        res
          .setHeader('content-type', 'text/html')
          .end(
            `<!doctype html><html><body><div id="app">${fallbackHtml}</div><script type="module" src="/main.js"></script></body></html>`,
          )
        return
      }
      // Browsers auto-request this; a 404 would show up as a console error.
      if (req.url === '/favicon.ico') return void res.writeHead(204).end()
      const file = path.join(root, outDir, 'client', req.url!)
      if (!fs.existsSync(file)) return void res.writeHead(404).end()
      res
        .setHeader('content-type', 'text/javascript')
        .end(fs.readFileSync(file))
    })
    await new Promise<void>((r) => server.listen(0, r))
    origin = `http://localhost:${(server.address() as any).port}`
    // CHROMIUM_PATH lets sandboxes with a pre-provisioned browser skip `playwright install`.
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
    fs.rmSync(path.join(root, outDir), { recursive: true, force: true })
  })

  test('SSR output: real markup wrapped in markers with serialized props', () => {
    // Server-rendered content is present (needed for hydration to attach).
    expect(html).toContain('Count: <!-- -->3')
    expect(html).toContain('id="static"')
    // Marker carries id/export/props; React HTML-escapes the attribute.
    expect(html).toMatch(
      /<vite-island data-island="[0-9a-f]{8}" data-export="Counter" data-props="\{&quot;start&quot;:3\}" data-hydrate="ssr"/,
    )
    // Counter (top level) + Panel = 2 markers. Counter nested inside Panel
    // must NOT get its own marker.
    expect(html.match(/<vite-island /g)).toHaveLength(2)
    expect(html).toContain('data-export="default"')
  })

  test('client dist: one lazy chunk per island + registry in main.js', () => {
    const assets = fs.readdirSync(path.join(root, outDir, 'client'), {
      recursive: true,
    }) as string[]
    expect(assets).toContain('main.js')
    // main.js is tiny glue; island code lives in separate chunks.
    const chunks = assets.filter((f) => f.endsWith('.js') && f !== 'main.js')
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Server-only page markup must not leak into the client bundle.
    const all = assets
      .filter((f) => f.endsWith('.js'))
      .map((f) =>
        fs.readFileSync(path.join(root, outDir, 'client', f), 'utf-8'),
      )
    expect(all.join('\n')).not.toContain('Static heading')
  })

  test('browser: islands hydrate, respond to clicks, no hydration errors', async () => {
    const page = await browser.newPage()
    const problems: string[] = []
    page.on('pageerror', (e) => problems.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        problems.push(m.text())
    })

    await page.goto(origin)
    // Top-level islands: Counter and Panel. Nested Counter is hydrated by Panel.
    await page.waitForFunction(
      () =>
        document.querySelectorAll('vite-island[data-hydrated]').length === 2,
    )

    const top = page.locator('vite-island >> nth=0').locator('#counter')
    await expect(top.textContent()).resolves.toBe('Count: 3')
    await top.click()
    await expect(top.textContent()).resolves.toBe('Count: 4')

    // Nested island (inside Panel) is live too.
    const nested = page.locator('#panel #counter')
    await expect(nested.textContent()).resolves.toBe('Count: 10')
    await nested.click()
    await expect(nested.textContent()).resolves.toBe('Count: 11')

    expect(problems).toEqual([])
    await page.close()
  })

  test('new props on a marker restart the island with fresh state', async () => {
    const page = await browser.newPage()
    await page.goto(origin)
    await page.waitForFunction(
      () =>
        document.querySelectorAll('vite-island[data-hydrated]').length === 2,
    )
    const top = page.locator('vite-island >> nth=0').locator('#counter')
    await top.click()
    await expect(top.textContent()).resolves.toBe('Count: 4')

    await page.evaluate(() =>
      document
        .querySelector('vite-island')!
        .setAttribute('data-props', '{"start":50}'),
    )
    await page.waitForFunction(
      () => document.querySelector('#counter')?.textContent === 'Count: 50',
    )
    await top.click()
    await expect(top.textContent()).resolves.toBe('Count: 51')
    await page.close()
  })

  describe('fallback states', () => {
    const chunk = '**/*ClientCounter*.js'

    test('SSR output: a client-rendered island carries its placeholder and no-JS content', () => {
      expect(fallbackHtml).toContain('data-state="pending"')
      expect(fallbackHtml).toContain('id="placeholder-cc"')
      expect(fallbackHtml).toContain('<noscript><p id="noscript-cc">')
      expect(fallbackHtml).not.toContain('failed')
      // Fallback is never part of the props.
      expect(fallbackHtml).toContain('data-props="{&quot;start&quot;:5}"')
    })

    test('the placeholder shows until the island mounts, then the island replaces it', async () => {
      const page = await browser.newPage()
      await page.route(chunk, async (route) => {
        await new Promise((r) => setTimeout(r, 800))
        await route.continue()
      })
      await page.goto(origin + '/fallback')
      await expect(page.locator('#placeholder-cc').isVisible()).resolves.toBe(
        true,
      )
      await expect(
        page.locator('vite-island >> nth=0').getAttribute('data-state'),
      ).resolves.toBe('pending')
      await page.waitForSelector('#client-counter')
      await expect(page.locator('#placeholder-cc').count()).resolves.toBe(0)
      await expect(
        page.locator('vite-island >> nth=0').getAttribute('data-state'),
      ).resolves.toBe('ready')
      await page.locator('#client-counter').click()
      await expect(page.locator('#client-counter').textContent()).resolves.toBe(
        'Client: 6',
      )
      await page.close()
    })

    test('a module that fails to load is logged and leaves the placeholder, with no failed state of its own', async () => {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      await page.route(chunk, (route) => route.abort())
      await page.goto(origin + '/fallback')
      await expect
        .poll(() => errors.some((e) => e.includes('failed to mount island')))
        .toBe(true)
      await expect(page.locator('#placeholder-cc').isVisible()).resolves.toBe(
        true,
      )
      await expect(
        page.locator('vite-island >> nth=0').getAttribute('data-state'),
      ).resolves.toBe('pending')
      await page.close()
    })

    test('an island that handles its own render failure shows its own message', async () => {
      const page = await browser.newPage()
      page.on('console', () => {}) // React logs the caught error
      await page.goto(origin + '/fallback')
      await page.waitForSelector('#own-failure')
      await expect(page.locator('#placeholder-ex').count()).resolves.toBe(0)
      await expect(
        page.locator('vite-island >> nth=1').getAttribute('data-state'),
      ).resolves.toBe('ready')
      // The sibling island is unaffected.
      await expect(page.locator('#client-counter').isVisible()).resolves.toBe(
        true,
      )
      await page.close()
    })

    test('with JavaScript off, the no-JS content is shown', async () => {
      const context = await browser.newContext({ javaScriptEnabled: false })
      const page = await context.newPage()
      await page.goto(origin + '/fallback')
      await expect(page.locator('#noscript-cc').isVisible()).resolves.toBe(true)
      await context.close()
    })
  })
})

describe('guards', () => {
  test('"use server" module reaching the client bundle fails the build', async () => {
    // BadIsland (client) -> server-only ("use server"): must be rejected.
    const config = fixtureConfig('dist-bad', 'src/entry-ssr.tsx', [
      'src/BadIsland.tsx',
    ])
    // Point the browser entry at the bad island via an inline entry module.
    config.plugins!.push({
      name: 'test:bad-entry',
      resolveId(id) {
        if (id.endsWith('src/main.js')) return '\0bad-main'
      },
      load(id) {
        if (id === '\0bad-main') return `import '/src/BadIsland.tsx'`
      },
    })
    const builder = await createBuilder(config)
    await expect(builder.build(builder.environments.client!)).rejects.toThrow(
      /"use server" module .*server-only\.ts/,
    )
    fs.rmSync(path.join(root, 'dist-bad'), { recursive: true, force: true })
  })
})
