/**
 * Browser-side runtime: finds `<vite-island>` markers emitted by
 * `./server.ts` and brings each one to life.
 *
 * The `registry` maps island id -> `() => import(module)`. Because every
 * entry is a dynamic import, the bundler emits one chunk per island module and
 * a page only downloads the code for islands that actually appear on it.
 */
import { createElement, type ComponentType } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'

export type IslandRegistry = Record<
  string,
  () => Promise<Record<string, unknown>>
>

const MARKER = 'vite-island'

/** Hydrates (or renders) one marker element. Never throws. */
async function mountIsland(el: HTMLElement, registry: IslandRegistry) {
  const { island: id, export: exportName = 'default', hydrate } = el.dataset
  const load = id ? registry[id] : undefined
  if (!id || !load) {
    console.warn(
      `[islands] no client module registered for island "${id}". The module ` +
        `is probably not matched by the plugin's \`include\` option.`,
      el,
    )
    return
  }

  try {
    const mod = await load()
    const Component = mod[exportName] as ComponentType<any> | undefined
    if (!Component) {
      throw new Error(`module for island "${id}" has no export "${exportName}"`)
    }
    const props = el.dataset.props ? JSON.parse(el.dataset.props) : {}
    const element = createElement(Component, props)

    if (hydrate === 'ssr') {
      // Server markup exists inside the marker: attach to it.
      hydrateRoot(el, element)
    } else {
      // Client-only island: marker is empty, render from scratch.
      createRoot(el).render(element)
    }
    el.setAttribute('data-hydrated', '')
  } catch (error) {
    // One broken island must not take down the others on the page.
    console.error(
      `[islands] failed to mount island "${id}" (${exportName})`,
      error,
    )
  }
}

/**
 * Hydrates every island under `root`.
 *
 * Safe to call more than once (e.g. after injecting HTML): already hydrated
 * markers are skipped.
 */
export function hydrateIslands(
  registry: IslandRegistry,
  root: ParentNode = document,
): Promise<void[]> {
  const jobs: Promise<void>[] = []
  for (const el of root.querySelectorAll<HTMLElement>(MARKER)) {
    if (el.hasAttribute('data-hydrated')) continue
    // Islands nested in another island are rendered by the outer island's
    // React tree; mounting a second root on them would fight React.
    if (el.parentElement?.closest(MARKER)) continue
    jobs.push(mountIsland(el, registry))
  }
  return Promise.all(jobs)
}
