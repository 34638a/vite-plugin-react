import { createElement } from 'react'
import { describe, expect, test } from 'vitest'
import { rewriteRefreshSelfImport } from '../src/refresh'
import { NOSCRIPT_CSS, serializeProps, wrap } from '../src/runtime/server'
import { hasPrologueDirective } from '../src/scan'

describe('hasPrologueDirective', () => {
  test.each([
    [`'use client'\nexport const a = 1`, true],
    [`"use client";\nexport const a = 1`, true],
    // comments/whitespace/BOM before the directive are fine
    [`﻿// header\n/* block */\n'use client'`, true],
    // multiple directives in the prologue
    [`'use strict'\n'use client'`, true],
    // a directive only counts in the prologue, not after real code
    [`import x from 'x'\n'use client'`, false],
    [`export const s = 'use client'`, false],
    // different directive
    [`'use server'\nexport async function a() {}`, false],
    [``, false],
  ])('%j -> %s', (code, expected) => {
    expect(hasPrologueDirective(code, 'use client')).toBe(expected)
  })
})

describe('serializeProps', () => {
  test('plain JSON round-trips', () => {
    const props = { a: 1, b: ['x', { c: null }], d: true }
    expect(JSON.parse(serializeProps(props, 'X'))).toEqual(props)
  })

  test.each([
    ['function', { onClick: () => {} }, /prop `onClick` is a function/],
    ['symbol', { s: Symbol('x') }, /is a symbol/],
    ['bigint', { n: 1n }, /is a bigint/],
    ['class instance', { m: new Map() }, /class instance \(Map\)/],
    [
      'react element',
      { el: { $$typeof: Symbol.for('react.element') } },
      /React element/,
    ],
  ])('rejects %s with a component-named error', (_n, props, message) => {
    expect(() => serializeProps(props as any, 'Widget')).toThrow(message)
    expect(() => serializeProps(props as any, 'Widget')).toThrow(/Widget/)
  })
})

describe('wrap', () => {
  test('non-component exports pass through untouched', () => {
    const useThing = () => 1
    const CONSTANT = 42
    const helper = () => 'h'
    expect(wrap(useThing, 'id', 'useThing', true)).toBe(useThing)
    expect(wrap(CONSTANT, 'id', 'CONSTANT', true)).toBe(CONSTANT)
    expect(wrap(helper, 'id', 'helper', true)).toBe(helper)
  })

  test('components, default exports and memo/forwardRef are wrapped', () => {
    const Comp = () => null
    expect(wrap(Comp, 'id', 'Comp', true)).not.toBe(Comp)
    expect(wrap(Comp, 'id', 'default', true)).not.toBe(Comp)
    const memo = { $$typeof: Symbol.for('react.memo') }
    expect(wrap(memo, 'id', 'Memo', true)).not.toBe(memo)
  })
})

describe('token props (host-supplied encoder)', () => {
  // A stand-in for an HBX token: not JSON-serializable, encoded by the host.
  class Token {
    constructor(readonly path: string) {}
    toJSON(): never {
      throw new Error('token serialized as JSON')
    }
  }
  const encoder = {
    isToken: (v: unknown): v is Token => v instanceof Token,
    encode: (v: Token) => `[[${v.path}]]`,
  }

  test('tokens are spliced into the JSON as encoder output', () => {
    const out = serializeProps(
      { a: new Token('x'), b: 3, c: { d: new Token('y.z') }, e: 'q"' },
      'X',
      encoder,
    )
    // A space follows a token that ends an object, so a template placeholder
    // such as `{{x}}` never touches the closing brace (`}}}` would lex as `{{{`'s close).
    expect(out).toBe('{"a":[[x]],"b":3,"c":{"d":[[y.z]] },"e":"q\\""}')
    expect(serializeProps({ a: new Token('x') }, 'X', encoder)).toBe(
      '{"a":[[x]] }',
    )
  })

  test('without an encoder a token is rejected, naming the component', () => {
    expect(() => serializeProps({ a: new Token('x') }, 'Widget')).toThrow(
      /Widget/,
    )
  })

  const Comp = (p: any) => {
    Comp.calls++
    return null as any
  }
  Comp.calls = 0

  test('a token prop forces client mode and skips rendering the component', () => {
    const W: any = wrap(Comp, 'id', 'Comp', true, { encoder })
    // Island is a function component; calling it needs no renderer when
    // there is no hook use outside context, so exercise via react-dom/server.
    return import('react-dom/server').then(async ({ renderToStaticMarkup }) => {
      const React = await import('react')
      Comp.calls = 0
      const html = renderToStaticMarkup(
        React.createElement(W, { a: new Token('x') }),
      )
      expect(html).toContain('data-hydrate="client"')
      expect(html).toContain('&quot;a&quot;:[[x]]')
      expect(Comp.calls).toBe(0)
    })
  })

  test('the mode comes from wrap(), and props reach the component unchanged', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = await import('react')
    let seen: any
    const C = (p: any) => ((seen = p), null as any)
    const client: any = wrap(C, 'id', 'C', false)
    expect(
      renderToStaticMarkup(React.createElement(client, { n: 1 })),
    ).toContain('data-hydrate="client"')
    expect(seen).toBeUndefined() // client mode: never rendered on the server
    const ssr: any = wrap(C, 'id', 'C', true)
    expect(renderToStaticMarkup(React.createElement(ssr, { n: 1 }))).toContain(
      'data-hydrate="ssr"',
    )
    expect(seen).toEqual({ n: 1 })
  })
})

describe('rewriteRefreshSelfImport', () => {
  const wrapped = (spec: string) =>
    `import * as __vite_react_currentExports from "${spec}";\nif (import.meta.hot) {}\n`

  test('points the refresh wrapper self-import at the /@fs/ URL', () => {
    expect(
      rewriteRefreshSelfImport(
        wrapped('/src/client/Counter.tsx'),
        'D:/site/src/client/Counter.tsx',
      ),
    ).toBe(wrapped('/@fs/D:/site/src/client/Counter.tsx'))
  })

  test('posix absolute paths do not get a double slash', () => {
    expect(
      rewriteRefreshSelfImport(
        wrapped('/src/a.tsx'),
        '/home/me/site/src/a.tsx',
      ),
    ).toBe(wrapped('/@fs/home/me/site/src/a.tsx'))
  })

  test('code without the wrapper import is returned as is', () => {
    const code = `import x from "/src/other.ts"\n`
    expect(rewriteRefreshSelfImport(code, 'D:/site/src/a.tsx')).toBe(code)
  })
})

describe('fallback', () => {
  const fallback = {
    placeholder: createElement('i', { id: 'p' }, 'placeholder'),
    noscript: createElement('u', { id: 'n' }, 'enable js'),
  }
  const render = async (
    mode: boolean,
    props: Record<string, unknown>,
    seen: { props?: unknown } = {},
  ) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const C = (p: any) => ((seen.props = p), null as any)
    const W: any = wrap(C, 'id', 'C', mode)
    return renderToStaticMarkup(createElement(W, props))
  }

  test('a client-rendered island carries a placeholder and no-JS content', async () => {
    const html = await render(false, { n: 1, fallback })
    expect(html).toContain('data-state="pending"')
    expect(html).toMatch(
      /<span data-island-placeholder[^>]*><i id="p">placeholder<\/i>/,
    )
    expect(html).toContain('<noscript><u id="n">enable js</u></noscript>')
  })

  test("there is no failed variant: failure is the component's to display", async () => {
    const html = await render(false, {
      n: 1,
      fallback: { ...fallback, failed: createElement('b', null, 'x') },
    })
    expect(html).not.toContain('<template')
    expect(html).not.toContain('failed')
  })

  test('fallback is never serialized and never reaches the component', async () => {
    const seen: { props?: unknown } = {}
    const html = await render(true, { n: 1, fallback }, seen)
    expect(html).not.toContain('fallback')
    expect(seen.props).toEqual({ n: 1 })
    const client = await render(false, { n: 1, fallback })
    expect(client).toContain('data-props="{&quot;n&quot;:1}"')
  })

  test('a server-rendered island has real markup already, so no fallback markup', async () => {
    const html = await render(true, { n: 1, fallback })
    expect(html).not.toContain('data-island-placeholder')
    expect(html).not.toContain('<noscript')
    expect(html).not.toContain('data-state')
  })

  test('only the variants given are emitted', async () => {
    const html = await render(false, {
      fallback: { placeholder: fallback.placeholder },
    })
    expect(html).toContain('data-island-placeholder')
    expect(html).not.toContain('<noscript')
  })

  test('a client-rendered island without a fallback keeps an empty marker', async () => {
    const html = await render(false, { n: 1 })
    expect(html).toMatch(
      /<vite-island [^>]*data-hydrate="client"[^>]*><\/vite-island>/,
    )
  })
})

describe('loading conditions (on* props)', () => {
  const render = async (
    props: Record<string, unknown>,
    seen: { props?: unknown } = {},
  ) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const C = (p: any) => ((seen.props = p), createElement('b', null, 'x'))
    const W: any = wrap(C, 'id', 'C', true)
    return renderToStaticMarkup(createElement(W, props))
  }

  test('conditions become data-on-* attributes and never reach the component or data-props', async () => {
    const seen: { props?: unknown } = {}
    const html = await render(
      {
        n: 1,
        onIdle: true,
        onVisible: '200px 0px',
        onAny: true,
        onSaveData: false,
      },
      seen,
    )
    expect(html).toContain('data-on-idle=""')
    expect(html).toContain('data-on-visible="200px 0px"')
    expect(html).toContain('data-on-any=""')
    expect(html).toContain('data-on-save-data="false"')
    expect(html).toContain('data-props="{&quot;n&quot;:1}"')
    expect(seen.props).toEqual({ n: 1 })
  })

  test('no on* props means no data-on-* attributes (the client loads it eagerly)', async () => {
    expect(await render({ n: 1 })).not.toContain('data-on-')
  })

  test('an invalid condition fails loudly, naming the component and the prop', async () => {
    await expect(render({ onMedia: true })).rejects.toThrow(/<C>.*onMedia/s)
  })
})

describe('defaultOn (per-file loading conditions)', () => {
  const render = async (
    props: Record<string, unknown>,
    defaultOn?: Record<string, unknown>,
  ) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const C = () => createElement('b', null, 'x')
    const W: any = wrap(C, 'id', 'C', true, { defaultOn })
    return renderToStaticMarkup(createElement(W, props))
  }

  test('a call with no conditions gets the file defaults', async () => {
    const html = await render(
      {},
      { onIdle: true, onMedia: '(min-width: 64em)' },
    )
    expect(html).toContain('data-on-idle=""')
    expect(html).toContain('data-on-media="(min-width: 64em)"')
  })

  test('call-site values win, and can switch a default off', async () => {
    const html = await render(
      { onMedia: '(min-width: 1px)', onIdle: false },
      { onIdle: true, onMedia: '(min-width: 64em)' },
    )
    expect(html).toContain('data-on-media="(min-width: 1px)"')
    expect(html).not.toContain('data-on-idle')
  })

  test('call-site conditions add to the defaults', async () => {
    const html = await render({ onVisible: true }, { onIdle: true })
    expect(html).toContain('data-on-idle=""')
    expect(html).toContain('data-on-visible=""')
  })
})

describe('children (static slot)', () => {
  const kid = createElement('p', { id: 'kid' }, 'static')
  const run = async (mode: boolean, props: Record<string, unknown>) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const seen: { props?: any } = {}
    const C = (p: any) => (
      (seen.props = p),
      createElement('section', null, p.children)
    )
    const W: any = wrap(C, 'id', 'C', mode)
    return { html: renderToStaticMarkup(createElement(W, props)), seen }
  }

  test('a server-rendered island renders its children inside a slot element', async () => {
    const { html, seen } = await run(true, { n: 1, children: kid })
    expect(html).toContain(
      '<section><vite-slot style="display:contents"><p id="kid">static</p></vite-slot></section>',
    )
    expect(html).toContain('data-props="{&quot;n&quot;:1}"')
    expect(seen.props.n).toBe(1)
  })

  test('a client-rendered island shows its children as the placeholder by default', async () => {
    const { html, seen } = await run(false, { n: 1, children: kid })
    expect(html).toContain(
      '<span data-island-placeholder="" data-island-slot="" style="display:contents"><p id="kid">static</p></span>',
    )
    expect(html).not.toContain('<template')
    expect(html).toContain('data-props="{&quot;n&quot;:1}"')
    expect(seen.props).toBeUndefined() // not rendered on the server
  })

  test('slotAsFallback={false} keeps the children inert in a template instead', async () => {
    const { html } = await run(false, {
      n: 1,
      children: kid,
      slotAsFallback: false,
    })
    expect(html).toContain(
      '<template data-island-slot=""><p id="kid">static</p></template>',
    )
    expect(html).not.toContain('data-island-placeholder')
  })

  test('any fallback prop keeps the children inert, and the fallback is the placeholder', async () => {
    const { html } = await run(false, {
      n: 1,
      children: kid,
      fallback: { placeholder: createElement('i', { id: 'own' }, 'own') },
    })
    expect(html).toContain(
      '<span data-island-placeholder="" style="display:contents"><i id="own">own</i></span>',
    )
    expect(html).toContain(
      '<template data-island-slot=""><p id="kid">static</p></template>',
    )
    // Even a fallback without a placeholder is "a fallback was set".
    const noscriptOnly = await run(false, {
      children: kid,
      fallback: { noscript: createElement('u', null, 'js') },
    })
    expect(noscriptOnly.html).toContain('<template data-island-slot="">')
    expect(noscriptOnly.html).not.toContain('data-island-placeholder')
  })

  test('a server-rendered island is unaffected: it already shows its real markup', async () => {
    const { html } = await run(true, { n: 1, children: kid })
    expect(html).not.toContain('data-island-placeholder')
    expect(html).not.toContain('<template')
  })

  test('slotAsFallback never reaches the component or data-props, and must be a boolean', async () => {
    const { html, seen } = await run(true, {
      n: 1,
      children: kid,
      slotAsFallback: false,
    })
    expect(seen.props).not.toHaveProperty('slotAsFallback')
    expect(html).not.toContain('slotAsFallback')
    await expect(run(false, { slotAsFallback: 'no' })).rejects.toThrow(
      /<C>.*slotAsFallback/s,
    )
  })

  test('no children means no slot markup', async () => {
    const ssr = await run(true, { n: 1 })
    const client = await run(false, { n: 1 })
    for (const { html } of [ssr, client]) {
      expect(html).not.toContain('vite-slot')
      expect(html).not.toContain('data-island-slot')
    }
  })
})

describe('build stamp', () => {
  test('the marker carries the build id the registry is checked against', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const W: any = wrap(() => null, 'id', 'C', true, { build: 'abc123' })
    expect(renderToStaticMarkup(createElement(W, {}))).toContain(
      'data-build="abc123"',
    )
  })

  test('no build id, no attribute', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const W: any = wrap(() => null, 'id', 'C', true)
    expect(renderToStaticMarkup(createElement(W, {}))).not.toContain(
      'data-build',
    )
  })
})

describe('no-JS content (noscript) and its CSS', () => {
  const kid = createElement('p', { id: 'kid' }, 'kid')
  const own = createElement('i', { id: 'own' }, 'own')
  const js = createElement('u', { id: 'js' }, 'enable js')
  const run = async (mode: boolean, props: Record<string, unknown>) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const W: any = wrap(() => createElement('b', null, 'x'), 'id', 'C', mode)
    return renderToStaticMarkup(createElement(W, props))
  }
  const marker = (html: string) => /<vite-island [^>]*>/.exec(html)![0]

  test('an explicit fallback.noscript is the no-JS content and marks the island', async () => {
    const html = await run(false, {
      fallback: { placeholder: own, noscript: js },
    })
    expect(html).toContain('<noscript><u id="js">enable js</u></noscript>')
    expect(marker(html)).toContain('data-has-noscript=""')
  })

  test('no no-JS content means no marker attribute (the placeholder then stays visible)', async () => {
    const html = await run(false, { children: kid })
    expect(html).not.toContain('<noscript')
    expect(marker(html)).not.toContain('data-has-noscript')
  })

  test('slotAsNoScript: the children are the no-JS content when something else is the placeholder', async () => {
    const html = await run(false, {
      children: kid,
      fallback: { placeholder: own },
      slotAsNoScript: true,
    })
    expect(html).toContain('<noscript><p id="kid">kid</p></noscript>')
    expect(marker(html)).toContain('data-has-noscript=""')
    // The inert template still holds them for the client.
    expect(html).toContain(
      '<template data-island-slot=""><p id="kid">kid</p></template>',
    )
  })

  test('slotAsNoScript does nothing while the children are already the visible placeholder', async () => {
    const html = await run(false, { children: kid, slotAsNoScript: true })
    expect(html).not.toContain('<noscript')
    expect(marker(html)).not.toContain('data-has-noscript')
    expect(html.match(/id="kid"/g)).toHaveLength(1) // nothing duplicated
  })

  test('slotAsNoScript with slotAsFallback={false}: children go to noscript, not the placeholder', async () => {
    const html = await run(false, {
      children: kid,
      slotAsFallback: false,
      slotAsNoScript: true,
    })
    expect(html).toContain('<noscript><p id="kid">kid</p></noscript>')
    expect(html).not.toContain('data-island-placeholder')
  })

  test('fallbackAsNoScript: the custom placeholder is also the no-JS content', async () => {
    const html = await run(false, {
      fallback: { placeholder: own },
      fallbackAsNoScript: true,
    })
    expect(html).toContain('<noscript><i id="own">own</i></noscript>')
    expect(marker(html)).toContain('data-has-noscript=""')
  })

  test('fallbackAsNoScript without a placeholder has nothing to copy', async () => {
    const html = await run(false, { fallback: {}, fallbackAsNoScript: true })
    expect(html).not.toContain('<noscript')
  })

  test('precedence: explicit noscript, then children, then the placeholder', async () => {
    const both = {
      children: kid,
      fallback: { placeholder: own },
      slotAsNoScript: true,
      fallbackAsNoScript: true,
    }
    expect(await run(false, both)).toContain(
      '<noscript><p id="kid">kid</p></noscript>',
    )
    const explicit = await run(false, {
      ...both,
      fallback: { placeholder: own, noscript: js },
    })
    expect(explicit).toContain('<noscript><u id="js">enable js</u></noscript>')
    expect(explicit).not.toContain('<noscript><p')
  })

  test('a server-rendered island takes none of it', async () => {
    const html = await run(true, {
      children: kid,
      fallback: { noscript: js },
      slotAsNoScript: true,
      fallbackAsNoScript: true,
    })
    expect(html).not.toContain('<noscript')
    expect(html).not.toContain('data-has-noscript')
  })

  test('the new props never reach the component or data-props, and must be booleans', async () => {
    const html = await run(false, {
      n: 1,
      slotAsNoScript: true,
      fallbackAsNoScript: true,
    })
    expect(html).not.toContain('AsNoScript')
    expect(html).toContain('data-props="{&quot;n&quot;:1}"')
    await expect(run(false, { slotAsNoScript: 'yes' })).rejects.toThrow(
      /<C>.*slotAsNoScript/s,
    )
    await expect(run(false, { fallbackAsNoScript: 1 })).rejects.toThrow(
      /<C>.*fallbackAsNoScript/s,
    )
  })

  test('the CSS hides placeholders of islands that have no-JS content, over their inline display:contents', () => {
    expect(NOSCRIPT_CSS).toBe(
      'vite-island[data-has-noscript]>[data-island-placeholder]{display:none!important}',
    )
  })
})
