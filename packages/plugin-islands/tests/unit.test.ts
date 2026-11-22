import { describe, expect, test } from 'vitest'
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
