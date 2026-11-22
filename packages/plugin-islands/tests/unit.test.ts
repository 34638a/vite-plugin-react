import { createElement } from 'react'
import { describe, expect, test } from 'vitest'
import { rewriteRefreshSelfImport } from '../src/refresh'
import { serializeProps, wrap } from '../src/runtime/server'
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
      'children',
      { children: 'hi' },
      /does not support children|do not support children/,
    ],
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
    const W: any = wrap(Comp, 'id', 'Comp', true, encoder)
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
