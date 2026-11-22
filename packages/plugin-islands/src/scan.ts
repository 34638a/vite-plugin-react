import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'

/**
 * Cheap, parser-free check for a directive in a module's *prologue*.
 *
 * A directive only counts when it is one of the first statements of the file
 * (after comments/whitespace), exactly like `'use strict'`. This mirrors the
 * AST check `hasDirective()` that the real transform performs later, but runs
 * on raw TSX/JSX source where we have not yet been through the TS/JSX
 * compiler. A false positive here is harmless: the transform re-checks with a
 * real AST before changing anything.
 */
export function hasPrologueDirective(code: string, directive: string): boolean {
  let pos = code.charCodeAt(0) === 0xfeff ? 1 : 0 // skip BOM
  const skip = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y
  const literal = /(["'])((?:(?!\1)[^\\\n])*)\1[ \t]*;?/y
  for (;;) {
    skip.lastIndex = pos
    if (skip.test(code)) pos = skip.lastIndex
    literal.lastIndex = pos
    const m = literal.exec(code)
    if (!m) return false // prologue ended without finding it
    if (m[2] === directive) return true
    pos = literal.lastIndex
  }
}

/**
 * Stable id for an island module: a short hash of its root-relative posix
 * path. It must be computed identically by the scanner (which feeds the client
 * registry) and the SSR transform (which writes it into the HTML), so both go
 * through this one function.
 */
export function islandId(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join('/')
  return createHash('sha256').update(rel).digest('hex').slice(0, 8)
}

/** Finds all `"use client"` modules under `root` matching the globs. */
export async function scanIslands(options: {
  root: string
  include: string[]
  exclude: string[]
}): Promise<Map<string, string>> {
  const files = await glob(options.include, {
    cwd: options.root,
    absolute: true,
    ignore: options.exclude,
  })
  const islands = new Map<string, string>() // id -> absolute file
  await Promise.all(
    files.map(async (file) => {
      const code = await fs.promises.readFile(file, 'utf-8')
      if (
        code.includes('use client') &&
        hasPrologueDirective(code, 'use client')
      ) {
        islands.set(islandId(options.root, file), file)
      }
    }),
  )
  // Deterministic ordering => reproducible chunk graph / registry output.
  return new Map([...islands].sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Identifies the set of island modules a page's HTML and its islands entry were
 * built from: a short hash of every island's id and source. Two builds of the
 * same sources (the SSR build and the client build) get the same id, so the
 * browser can tell when a cached entry no longer matches the HTML it hydrates.
 * Code an island only imports is not covered; pass `buildId` to cover more.
 */
export async function buildIdOf(
  registry: Map<string, string>,
): Promise<string> {
  const hash = createHash('sha256')
  const entries = [...registry].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [id, file] of entries) {
    hash.update(id)
    hash.update(await fs.promises.readFile(file))
  }
  return hash.digest('hex').slice(0, 8)
}
