/**
 * Browser-side runtime: finds `<vite-island>` markers emitted by
 * `./server.ts` and brings each one to life.
 *
 * The `registry` maps island id -> `() => import(module)`. Because every
 * entry is a dynamic import, the bundler emits one chunk per island module and
 * a page only downloads the code for islands that actually appear on it.
 */
import { createElement, type ComponentType } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import {
  browserEnv,
  createScheduler,
  observableTargets,
  readConditions,
} from './load'

export type IslandRegistry = Record<
  string,
  () => Promise<Record<string, unknown>>
>

const MARKER = 'vite-island'

/** Build ids already reported as not matching the islands entry. */
const reportedBuilds = new Set<string>()

const schedule = createScheduler(browserEnv)
/** Markers already handed to the scheduler (a pending one has no data-hydrated yet). */
const scheduled = new WeakSet<Element>()

/**
 * Hydrates (or renders) one marker element. Never throws.
 *
 * The marker's `data-state` is `pending` (set by the server for a
 * client-rendered island) until the island is mounted, then `ready`. A failure
 * is logged and shown by nothing here: the placeholder stays, and what an
 * island displays when it breaks is the component's own business.
 */
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

  // The island's `children`, server-rendered static HTML. Read before mounting
  // (React clears the marker's children): from a client-rendered island's
  // [data-island-slot] (an inert template, or the visible placeholder they
  // double as) or from the slot inside a server-rendered one.
  const slot =
    el.querySelector<HTMLElement>(':scope > [data-island-slot]')?.innerHTML ??
    [...el.querySelectorAll('vite-slot')].find((s) => s.closest(MARKER) === el)
      ?.innerHTML

  let root: Root | undefined
  // One broken island must not take down the others on the page.
  const report = (what: string, error: unknown) =>
    console.error(`[islands] ${what} "${id}" (${exportName})`, error)

  try {
    const mod = await load()
    const Component = mod[exportName] as ComponentType<any> | undefined
    if (!Component) {
      throw new Error(`module for island "${id}" has no export "${exportName}"`)
    }
    const start = (mode: string | undefined): Root => {
      const props = el.dataset.props ? JSON.parse(el.dataset.props) : {}
      const element = createElement(
        Component,
        slot === undefined
          ? props
          : {
              ...props,
              // The same element the server rendered, whose content React must
              // not diff: it is HTML the page already holds.
              children: createElement('vite-slot', {
                suppressHydrationWarning: true,
                style: { display: 'contents' },
                dangerouslySetInnerHTML: { __html: slot },
              }),
            },
      )
      if (mode === 'ssr') {
        // Server markup exists inside the marker: attach to it.
        return hydrateRoot(el, element)
      }
      // Client-only island: marker holds only fallback content, render over it.
      const created = createRoot(el)
      created.render(element)
      return created
    }

    root = start(hydrate)
    el.setAttribute('data-hydrated', '')
    el.setAttribute('data-state', 'ready')

    // New props (the marker's HTML was replaced or patched in place) restart
    // the island with fresh state. Any server markup is stale by then, so the
    // restart always renders on the client.
    new MutationObserver(() => {
      try {
        root?.unmount()
        root = start('client')
        el.setAttribute('data-state', 'ready')
      } catch (error) {
        report('failed to restart island', error)
      }
    }).observe(el, { attributes: true, attributeFilter: ['data-props'] })
  } catch (error) {
    report('failed to mount island', error)
  }
}

/**
 * A marker stamped with another build than the islands entry means the cached
 * entry (or the cached HTML) is out of date: islands may be missing from the
 * registry or not match the markup. Say so once per build instead of leaving
 * inert islands to explain themselves.
 */
function warnIfStale(el: HTMLElement, build: string | null | undefined) {
  const pageBuild = el.dataset.build
  if (!build || !pageBuild || pageBuild === build) return
  if (reportedBuilds.has(pageBuild)) return
  reportedBuilds.add(pageBuild)
  console.warn(
    `[islands] this page's HTML was built for islands build "${pageBuild}" but ` +
      `the islands entry is build "${build}". One of them is stale (cached): ` +
      `serve the entry with a content hash or revalidation. Islands may not ` +
      `hydrate until they match.`,
  )
}

/**
 * Hydrates every island under `root`.
 *
 * Safe to call more than once (e.g. after injecting HTML): already hydrated
 * or scheduled markers are skipped.
 *
 * Each island loads on the conditions of its `data-on-*` attributes (see
 * `./load`). The returned promise settles when the islands with no conditions
 * have mounted; the others are only scheduled by then.
 */
export function hydrateIslands(
  registry: IslandRegistry,
  root: ParentNode = document,
  options: { build?: string | null } = {},
): Promise<void[]> {
  const jobs: Promise<void>[] = []
  for (const el of root.querySelectorAll<HTMLElement>(MARKER)) {
    if (el.hasAttribute('data-hydrated')) continue
    // Islands nested in another island are rendered by the outer island's
    // React tree; mounting a second root on them would fight React.
    if (el.parentElement?.closest(MARKER)) continue
    warnIfStale(el, options.build)
    // Conditional islands are scheduled, not awaited: a `visible` one may never load.
    if (scheduled.has(el)) continue
    scheduled.add(el)
    const { conditions, any } = readConditions(el.dataset)
    const watches = conditions.some(
      (c) => c.on === 'visible' || c.on === 'interaction',
    )
    const job = schedule(
      conditions,
      any,
      { marker: el, targets: watches ? observableTargets(el) : [] },
      () => mountIsland(el, registry),
    )
    if (job) jobs.push(job)
  }
  return Promise.all(jobs)
}
