/**
 * Server-side (SSR) runtime.
 *
 * The plugin rewrites every `"use client"` module so that its component
 * exports are passed through {@link wrap}. The wrapped component:
 *
 *   1. renders the *real* component, so the static HTML contains the full
 *      server-rendered markup (this is what makes hydration, rather than a
 *      blank client render, possible), and
 *   2. surrounds that markup with a `<vite-island>` marker element carrying
 *      everything the browser needs to re-attach interactivity:
 *
 *        <vite-island data-island="a1b2c3d4"      <- which module (registry key)
 *                     data-export="Counter"       <- which export of that module
 *                     data-props='{"start":3}'    <- JSON props
 *                     data-hydrate="ssr"          <- hydrateRoot vs createRoot
 *                     style="display:contents">   <- marker adds no layout box
 *           ...server-rendered <Counter/> markup...
 *         </vite-island>
 *
 * The matching browser half lives in `./client.ts`.
 */
import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactNode,
} from 'react'

/**
 * True while rendering *inside* an island's server markup.
 *
 * Client components can import other client components. In the browser the
 * outer island's bundle renders the inner one as a plain component (no marker
 * element), so the server markup must not contain an inner marker either, or
 * hydration would see an extra DOM node and mismatch. Inner components
 * therefore render unwrapped when this context is set.
 */
const InsideIsland = createContext(false)

// React exotic component types that can be rendered but are not functions.
const EXOTIC_COMPONENT_TYPES = [
  Symbol.for('react.memo'),
  Symbol.for('react.forward_ref'),
  Symbol.for('react.lazy'),
]

/**
 * Decides whether an export of a `"use client"` module is a component (and so
 * should become an island) or something else (hooks, constants, helpers),
 * which must pass through untouched so server code can still import them.
 */
function isComponent(value: unknown, exportName: string): boolean {
  if (typeof value === 'function') {
    // Anonymous default exports (`export default () => <div/>`) have no
    // usable name; treat default exports as components.
    if (exportName === 'default') return true
    return /^[A-Z]/.test(exportName)
  }
  return (
    typeof value === 'object' &&
    value != null &&
    EXOTIC_COMPONENT_TYPES.includes((value as any).$$typeof)
  )
}

/**
 * Serializes props for the `data-props` attribute.
 *
 * Props cross a process boundary (server -> HTML -> browser), so only JSON
 * can survive. Anything else is a bug in the page, and silently dropping it
 * would produce an island that renders differently on the client, so fail
 * loudly with the component name instead.
 *
 * Note the attribute value itself is HTML-escaped by React, so arbitrary
 * string content in props cannot break out of the attribute.
 */
export function serializeProps(
  props: Record<string, unknown>,
  label: string,
): string {
  if (props.children != null) {
    throw new Error(
      `[islands] <${label}> received \`children\`. React elements cannot be ` +
        `serialized into the HTML marker, so islands do not support children ` +
        `yet. Pass data as props instead.`,
    )
  }
  return JSON.stringify(props, (key, value) => {
    const type = typeof value
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      throw new Error(
        `[islands] <${label}> prop \`${key}\` is a ${type}, which cannot be ` +
          `serialized for hydration. Island props must be JSON-compatible.`,
      )
    }
    if (type === 'object' && value != null) {
      if ('$$typeof' in value) {
        throw new Error(
          `[islands] <${label}> prop \`${key}\` is a React element, which ` +
            `cannot be serialized for hydration.`,
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (
        !Array.isArray(value) &&
        proto !== Object.prototype &&
        proto != null
      ) {
        throw new Error(
          `[islands] <${label}> prop \`${key}\` is a class instance ` +
            `(${proto?.constructor?.name}); only plain objects and arrays ` +
            `can be serialized for hydration.`,
        )
      }
    }
    return value
  })
}

/**
 * Called by plugin-generated code, once per export of every `"use client"`
 * module, in the SSR environment only.
 *
 * @param value      the original export
 * @param id         stable island id (hash of the module path) used as the
 *                   key into the client registry
 * @param exportName export name (`default` for default exports)
 * @param hydrate    `true`: server-render the component and hydrate it.
 *                   `false`: emit only the marker, client renders from scratch
 *                   (for components that touch `window` during render).
 */
export function wrap<T>(
  value: T,
  id: string,
  exportName: string,
  hydrate: boolean,
): T {
  if (!isComponent(value, exportName)) return value

  const Original = value as unknown as ComponentType<any>
  const label =
    exportName === 'default'
      ? (Original.displayName ?? Original.name ?? 'default')
      : exportName

  function Island(props: Record<string, unknown>): ReactNode {
    // Nested client component: the outer island already owns this subtree.
    if (useContext(InsideIsland)) return createElement(Original, props)

    return createElement(
      'vite-island',
      {
        'data-island': id,
        'data-export': exportName,
        'data-props': serializeProps(props, label),
        'data-hydrate': hydrate ? 'ssr' : 'client',
        // The marker is purely structural; keep it out of layout/CSS flow.
        style: { display: 'contents' },
      },
      hydrate
        ? createElement(
            InsideIsland.Provider,
            { value: true },
            createElement(Original, props),
          )
        : null,
    )
  }
  Island.displayName = `Island(${label})`
  return Island as unknown as T
}
