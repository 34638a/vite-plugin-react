import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { revalidateOptimizedDeps } from '../src/devDeps'
import { buildIdOf } from '../src/scan'

describe('buildIdOf', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'islands-build-'))
  const write = (name: string, text: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, text)
    return file
  }

  test('is stable for the same islands, whatever order they were found in', async () => {
    const a = write('a.tsx', 'export const A = 1')
    const b = write('b.tsx', 'export const B = 2')
    const one = await buildIdOf(
      new Map([
        ['aaaa', a],
        ['bbbb', b],
      ]),
    )
    const two = await buildIdOf(
      new Map([
        ['bbbb', b],
        ['aaaa', a],
      ]),
    )
    expect(one).toBe(two)
    expect(one).toMatch(/^[0-9a-f]{8}$/)
  })

  test('changes when an island module changes', async () => {
    const a = write('c.tsx', 'export const A = 1')
    const before = await buildIdOf(new Map([['aaaa', a]]))
    fs.writeFileSync(a, 'export const A = 2')
    expect(await buildIdOf(new Map([['aaaa', a]]))).not.toBe(before)
  })

  test('changes when an island is added', async () => {
    const a = write('d.tsx', 'x')
    const b = write('e.tsx', 'y')
    expect(await buildIdOf(new Map([['aaaa', a]]))).not.toBe(
      await buildIdOf(
        new Map([
          ['aaaa', a],
          ['bbbb', b],
        ]),
      ),
    )
  })
})

describe('revalidateOptimizedDeps', () => {
  const run = (url: string) => {
    const headers: Record<string, string> = {}
    const res = {
      setHeader: (name: string, value: string) => void (headers[name] = value),
    }
    const next = vi.fn()
    revalidateOptimizedDeps({ url } as any, res as any, next)
    // What Vite then does when it serves the dependency:
    res.setHeader('Cache-Control', 'max-age=31536000,immutable')
    res.setHeader('Content-Type', 'text/javascript')
    return { headers, next }
  }

  test('a pre-bundled dependency is revalidated instead of cached as immutable', () => {
    const { headers, next } = run(
      '/node_modules/.vite/deps/react.js?v=a6387fc5',
    )
    expect(headers['Cache-Control']).toBe('no-cache')
    expect(headers['Content-Type']).toBe('text/javascript') // everything else untouched
    expect(next).toHaveBeenCalledOnce()
  })

  test('other URLs keep their caching', () => {
    const { headers } = run('/src/client/Counter.tsx?import')
    expect(headers['Cache-Control']).toBe('max-age=31536000,immutable')
  })
})
