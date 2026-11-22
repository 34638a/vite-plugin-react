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
import { chromium, type Browser, type Page } from '@playwright/test'
import { createBuilder, type InlineConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { islands } from '../src/index'
import { NOSCRIPT_CSS } from '../src/runtime/noscript'

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
        clientOnly: (file) =>
          /(ClientCounter|Exploder|ClientCard)\.tsx$/.test(file),
        defaultOn: (file) =>
          /Defaulted\.tsx$/.test(file)
            ? { onMedia: '(min-width: 5000px)' }
            : undefined,
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
  let loadHtml: string
  let slotHtml: string
  let noscriptHtml: string
  let defaultsHtml: string
  let server: http.Server
  let origin: string
  let browser: Browser

  beforeAll(async () => {
    // Only the good fixture files: BadIsland is exercised separately.
    const builder = await createBuilder(
      fixtureConfig(outDir, undefined, [
        'src/{Counter,Panel,Page,entry-ssr,ClientCounter,Exploder,FallbackPage,Tagged,LoadPage,Card,ClientCard,SlotPage,Defaulted,DefaultsPage,NoscriptPage}.tsx',
      ]),
    )
    await builder.buildApp()

    // Run the SSR bundle exactly like a custom renderer would.
    const ssr = await import(
      pathToFileURL(path.join(root, outDir, 'ssr/entry.js')).href
    )
    html = ssr.render()
    fallbackHtml = ssr.renderFallback()
    loadHtml = ssr.renderLoad()
    slotHtml = ssr.renderSlot()
    noscriptHtml = ssr.renderNoscript()
    defaultsHtml = ssr.renderDefaults()

    // Serve what Apache would: a static page + the client dist.
    const page = `<!doctype html><html><body><div id="app">${html}</div>
<script type="module" src="/main.js"></script></body></html>`
    server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html').end(page)
        return
      }
      if (req.url === '/noscript') {
        // The style goes at the end of <head>, inside <noscript>, as a host would embed it.
        res
          .setHeader('content-type', 'text/html')
          .end(
            `<!doctype html><html><head><noscript><style>${NOSCRIPT_CSS}</style></noscript></head><body><div id="app">${noscriptHtml}</div><script type="module" src="/main.js"></script></body></html>`,
          )
        return
      }
      for (const [route, body] of [
        ['/slot', slotHtml],
        ['/defaults', defaultsHtml],
      ] as const) {
        if (req.url === route) {
          res
            .setHeader('content-type', 'text/html')
            .end(
              `<!doctype html><html><body><div id="app">${body}</div><script type="module" src="/main.js"></script></body></html>`,
            )
          return
        }
      }
      if (req.url === '/load') {
        res
          .setHeader('content-type', 'text/html')
          .end(
            `<!doctype html><html><body><div id="app">${loadHtml}</div><script type="module" src="/main.js"></script></body></html>`,
          )
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

  describe('children (static slot)', () => {
    const chunk = '**/*ClientCard*.js'
    const slow = (page: Page) =>
      page.route(chunk, async (route) => {
        await new Promise((r) => setTimeout(r, 800))
        await route.continue()
      })
    const visible = (page: Page, selector: string) =>
      page.locator(selector).isVisible()

    test('SSR output: a server-rendered island slots its children; client-rendered ones show them as the placeholder unless told otherwise', () => {
      expect(slotHtml).toContain(
        '<vite-slot style="display:contents"><p id="kid-ssr">static kid</p></vite-slot>',
      )
      // Default: the children are the visible placeholder.
      expect(slotHtml).toContain(
        '<span data-island-placeholder="" data-island-slot="" style="display:contents"><p id="kid-client">client kid</p></span>',
      )
      // slotAsFallback={false} and an explicit fallback keep them inert.
      expect(slotHtml).toContain(
        '<template data-island-slot=""><p id="kid-inert">inert kid</p></template>',
      )
      expect(slotHtml).toContain(
        '<template data-island-slot=""><p id="kid-withfb">withfb kid</p></template>',
      )
      expect(slotHtml).toContain('id="own-placeholder"')
      // Children are never part of the props.
      expect(slotHtml).not.toContain('kid&quot;')
    })

    test('the slot content survives hydration without errors, and the island is live', async () => {
      const page = await browser.newPage()
      const problems: string[] = []
      page.on('pageerror', (e) => problems.push(e.message))
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning')
          problems.push(m.text())
      })
      await page.goto(origin + '/slot')
      await page.waitForFunction(
        () =>
          document.querySelectorAll('vite-island[data-hydrated]').length === 4,
      )
      await expect(
        page.locator('#slot-ssr #kid-ssr').textContent(),
      ).resolves.toBe('static kid')
      await page.locator('button[data-card="ssr"]').click()
      await expect(
        page.locator('button[data-card="ssr"]').textContent(),
      ).resolves.toBe('1')
      // The slot is still there after the island re-rendered.
      await expect(page.locator('#slot-ssr #kid-ssr').count()).resolves.toBe(1)
      expect(problems).toEqual([])
      await page.close()
    })

    test('by default the children are visible before the island loads, then the island hands them back as its slot', async () => {
      const page = await browser.newPage()
      await slow(page)
      await page.goto(origin + '/slot')
      // Not mounted yet: the children stand in as the placeholder.
      await expect(visible(page, '#kid-client')).resolves.toBe(true)
      await expect(
        page.locator('[data-island-placeholder] #kid-client').count(),
      ).resolves.toBe(1)
      await page.waitForFunction(
        () => !!document.querySelector('#slot-client #kid-client'),
      )
      // Mounted: the same content now lives in the island's own slot, and the placeholder is gone.
      await expect(
        page.locator('#slot-client #kid-client').textContent(),
      ).resolves.toBe('client kid')
      await expect(
        page.locator('[data-island-placeholder] #kid-client').count(),
      ).resolves.toBe(0)
      await expect(page.locator('#kid-client').count()).resolves.toBe(1)
      await page.locator('button[data-card="client"]').click()
      await expect(
        page.locator('button[data-card="client"]').textContent(),
      ).resolves.toBe('1')
      await page.close()
    })

    test('the children show with JavaScript off, since they are the placeholder', async () => {
      const context = await browser.newContext({ javaScriptEnabled: false })
      const page = await context.newPage()
      await page.goto(origin + '/slot')
      await expect(visible(page, '#kid-client')).resolves.toBe(true)
      await context.close()
    })

    test('slotAsFallback={false} keeps the children out of sight until the island mounts', async () => {
      const page = await browser.newPage()
      await slow(page)
      await page.goto(origin + '/slot')
      await expect(visible(page, '#kid-inert')).resolves.toBe(false)
      await page.waitForFunction(
        () => !!document.querySelector('#slot-inert #kid-inert'),
      )
      await expect(
        page.locator('#slot-inert #kid-inert').textContent(),
      ).resolves.toBe('inert kid')
      await page.close()
    })

    test('a fallback of its own is the placeholder; the children wait for the island', async () => {
      const page = await browser.newPage()
      await slow(page)
      await page.goto(origin + '/slot')
      await expect(visible(page, '#own-placeholder')).resolves.toBe(true)
      await expect(visible(page, '#kid-withfb')).resolves.toBe(false)
      await page.waitForFunction(
        () => !!document.querySelector('#slot-withfb #kid-withfb'),
      )
      await expect(page.locator('#own-placeholder').count()).resolves.toBe(0)
      await page.close()
    })
  })

  describe('no-JS content (noscript) and the head style', () => {
    const noJs = async () => {
      const context = await browser.newContext({ javaScriptEnabled: false })
      const page = await context.newPage()
      await page.goto(origin + '/noscript')
      return { page, close: () => context.close() }
    }
    const visible = (page: Page, selector: string) =>
      page.locator(selector).first().isVisible()

    test('SSR output: only islands with no-JS content are marked', () => {
      // explicit, slotAsNoScript and fallbackAsNoScript: three. "plain" and
      // "dup" (children already the visible placeholder) have none.
      expect(noscriptHtml.match(/data-has-noscript=""/g)).toHaveLength(3)
    })

    test('with scripts off, the style hides the placeholder of an island that has no-JS content, and shows the no-JS content', async () => {
      const { page, close } = await noJs()
      // The placeholder carries an inline display:contents; the rule must beat it.
      await expect(visible(page, '#ph-explicit')).resolves.toBe(false)
      await expect(visible(page, '#ns-explicit')).resolves.toBe(true)
      await close()
    })

    test('with no no-JS content, the placeholder stays visible (the children, here)', async () => {
      const { page, close } = await noJs()
      await expect(visible(page, '#kid-plain')).resolves.toBe(true)
      await close()
    })

    test('slotAsNoScript: the placeholder is hidden and the children show from the no-JS content', async () => {
      const { page, close } = await noJs()
      await expect(visible(page, '#ph-slotns')).resolves.toBe(false)
      await expect(visible(page, 'noscript #kid-slotns')).resolves.toBe(true)
      await close()
    })

    test('fallbackAsNoScript: the placeholder is hidden and its copy in the no-JS content shows', async () => {
      const { page, close } = await noJs()
      await expect(
        visible(page, '[data-island-placeholder] #ph-fbns'),
      ).resolves.toBe(false)
      await expect(visible(page, 'noscript #ph-fbns')).resolves.toBe(true)
      await close()
    })

    test('slotAsNoScript while the children are the placeholder adds nothing: shown once, not hidden', async () => {
      const { page, close } = await noJs()
      await expect(page.locator('#kid-dup').count()).resolves.toBe(1)
      await expect(visible(page, '#kid-dup')).resolves.toBe(true)
      await close()
    })

    test('with scripts on the style is inert: the placeholder shows until the island mounts', async () => {
      const page = await browser.newPage()
      await page.route('**/*ClientCard*.js', async (route) => {
        await new Promise((r) => setTimeout(r, 800))
        await route.continue()
      })
      await page.goto(origin + '/noscript')
      await expect(visible(page, '#ph-explicit')).resolves.toBe(true)
      await page.waitForFunction(
        () =>
          document.querySelectorAll('vite-island[data-hydrated]').length === 5,
      )
      await expect(page.locator('#ph-explicit').count()).resolves.toBe(0)
      await page.close()
    })
  })

  describe('defaultOn', () => {
    test('SSR output: the file default is on the marker, a call-site value wins', () => {
      expect(defaultsHtml).toContain('data-on-media="(min-width: 5000px)"')
      expect(defaultsHtml).toContain('data-on-media="(min-width: 1px)"')
    })

    test('the default condition is honoured; the overridden island loads at once', async () => {
      const page = await browser.newPage()
      await page.goto(origin + '/defaults')
      await page.waitForFunction(
        () =>
          !!document
            .querySelector('button[data-name="overridden"]')
            ?.closest('vite-island[data-hydrated]'),
      )
      await page.waitForTimeout(300)
      const hydratedNames = () =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll('vite-island[data-hydrated] button'),
          ].map((b) => (b as HTMLElement).dataset.name),
        )
      expect(await hydratedNames()).toEqual(['overridden'])
      await page.setViewportSize({ width: 5200, height: 800 })
      await page.waitForFunction(
        () =>
          document.querySelectorAll('vite-island[data-hydrated]').length === 2,
      )
      await page.close()
    })
  })

  describe('build stamp', () => {
    test('the markers and the islands entry carry the same build id', () => {
      const id = /data-build="([0-9a-f]{8})"/.exec(html)?.[1]
      expect(id).toBeTruthy()
      const assets = fs.readdirSync(path.join(root, outDir, 'client'), {
        recursive: true,
      }) as string[]
      const client = assets
        .filter((f) => f.endsWith('.js'))
        .map((f) =>
          fs.readFileSync(path.join(root, outDir, 'client', f), 'utf-8'),
        )
        .join('\n')
      expect(client).toContain(id!)
    })

    test('a page whose HTML is from another build than its islands entry says so, once', async () => {
      const page = await browser.newPage()
      const warnings: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'warning') warnings.push(m.text())
      })
      await page.route(origin + '/', async (route) => {
        const response = await route.fetch()
        const body = (await response.text()).replace(
          /data-build="[0-9a-f]{8}"/g,
          'data-build="stale000"',
        )
        await route.fulfill({ response, body })
      })
      await page.goto(origin)
      await expect
        .poll(() => warnings.filter((w) => w.includes('islands build')).length)
        .toBe(1)
      expect(warnings.join('\n')).toContain('"stale000"')
      await page.close()
    })
  })

  describe('loading conditions', () => {
    const hydrated = (page: Page) =>
      page.evaluate(() =>
        [...document.querySelectorAll('vite-island[data-hydrated]')].map(
          (el) => (el as HTMLElement).querySelector('button')!.dataset.name,
        ),
      )
    // Runs in the page, so it takes the island name as an argument.
    const isHydrated = (name: string) =>
      !!document
        .querySelector(`button[data-name="${name}"]`)
        ?.closest('vite-island[data-hydrated]')
    const scrollTo = (page: Page, name: string) =>
      page.locator(`button[data-name="${name}"]`).scrollIntoViewIfNeeded()
    /** Idle time only comes when the test says so (one slice per call). */
    const manualIdle = (page: Page) =>
      page.addInitScript(() => {
        const slices: Array<() => void> = []
        ;(window as any).__slices = slices
        ;(window as any).requestIdleCallback = (cb: () => void) =>
          slices.push(cb)
      })
    const runSlice = (page: Page) =>
      page.evaluate(() => (window as any).__slices.shift()())
    const settle = async (page: Page, count: number) => {
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('vite-island[data-hydrated]').length === n,
        count,
      )
      await page.waitForTimeout(150) // and nothing more arrives on its own
      expect((await hydrated(page)).length).toBe(count)
    }

    test('SSR output: the conditions are data-on-* attributes, not props', () => {
      expect(loadHtml).toContain('data-on-load=""')
      expect(loadHtml).toContain('data-on-interaction=""')
      expect(loadHtml).toContain('data-on-media="(min-width: 5000px)"')
      expect(loadHtml).toContain('data-on-idle=""')
      expect(loadHtml).toContain('data-on-visible=""')
      expect(loadHtml).toContain('data-on-any=""')
      expect(loadHtml).not.toContain('onVisible')
    })

    test('with no conditions an island mounts at once; onVisible waits until it is scrolled to', async () => {
      const page = await browser.newPage()
      await page.goto(origin + '/load')
      await page.waitForFunction(isHydrated, 'eager')
      await page.waitForTimeout(400)
      expect(await hydrated(page)).not.toContain('visible')
      await scrollTo(page, 'visible')
      await page.waitForFunction(isHydrated, 'visible')
      await page.close()
    })

    test('onLoad and onIdle load by themselves; the rest wait for what they asked for', async () => {
      const page = await browser.newPage()
      await page.goto(origin + '/load')
      await page.waitForFunction(isHydrated, 'hybrid')
      await page.waitForFunction(isHydrated, 'idle-2')
      const names = await hydrated(page)
      expect(names).toEqual(
        expect.arrayContaining(['eager', 'load', 'idle-1', 'idle-2', 'hybrid']),
      )
      // Nothing scrolled, clicked or resized: these are still waiting.
      for (const waiting of ['interaction', 'media', 'visible', 'and'])
        expect(names).not.toContain(waiting)
      await page.close()
    })

    test('onInteraction loads on the first click', async () => {
      const page = await browser.newPage()
      await page.goto(origin + '/load')
      await page.waitForFunction(isHydrated, 'eager')
      await page.waitForTimeout(300)
      expect(await hydrated(page)).not.toContain('interaction')
      await page.locator('button[data-name="interaction"]').click()
      await page.waitForFunction(isHydrated, 'interaction')
      await page.close()
    })

    test('onMedia loads once the viewport matches', async () => {
      const page = await browser.newPage()
      await page.goto(origin + '/load')
      await page.waitForFunction(isHydrated, 'eager')
      await page.waitForTimeout(300)
      expect(await hydrated(page)).not.toContain('media')
      await page.setViewportSize({ width: 5200, height: 800 })
      await page.waitForFunction(isHydrated, 'media')
      await page.close()
    })

    test('onIdle is gradual: one island per idle slice, in document order', async () => {
      const page = await browser.newPage()
      await manualIdle(page)
      await page.goto(origin + '/load')
      await settle(page, 2) // eager and onLoad: no idle time has come yet
      await runSlice(page)
      await settle(page, 3)
      expect(await hydrated(page)).toContain('idle-1')
      await runSlice(page)
      await settle(page, 4)
      expect(await hydrated(page)).toContain('idle-2')
      await runSlice(page)
      await settle(page, 5)
      expect(await hydrated(page)).toContain('hybrid')
      await page.close()
    })

    test('onIdle + onVisible + onAny loads right now when scrolled to before its idle turn', async () => {
      const page = await browser.newPage()
      await page.addInitScript(() => {
        ;(window as any).requestIdleCallback = () => 0 // idle time never comes
      })
      await page.goto(origin + '/load')
      await settle(page, 2)
      await scrollTo(page, 'hybrid')
      await page.waitForFunction(isHydrated, 'hybrid')
      // The idle islands are still waiting: visibility loaded only this one.
      expect(await hydrated(page)).toEqual(['eager', 'load', 'hybrid'])
      await page.close()
    })

    test('onIdle + onVisible without onAny needs both: visible alone is not enough', async () => {
      const page = await browser.newPage()
      await manualIdle(page)
      await page.goto(origin + '/load')
      await settle(page, 2)
      await scrollTo(page, 'and')
      await page.waitForTimeout(400)
      expect(await hydrated(page)).not.toContain('and')
      // idle-1, idle-2 and hybrid take the first three slices; then it is its turn.
      for (let n = 0; n < 4; n++) await runSlice(page)
      await page.waitForFunction(isHydrated, 'and')
      await page.close()
    })
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
