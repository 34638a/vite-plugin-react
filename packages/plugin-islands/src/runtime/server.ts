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
import { splitOnProps, type IslandOn } from './load'
import { NOSCRIPT_CSS } from './noscript'

export { NOSCRIPT_CSS }

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
 * Host-supplied handling for props that are not JSON but a placeholder the
 * host resolves later (e.g. a template expression). Passed to `wrap` by the
 * generated code from the `tokenEncoder` plugin option.
 */
export interface TokenEncoder {
  isToken(value: unknown): boolean
  /** Text spliced into `data-props` where the token sits (a JSON fragment). */
  encode(value: any): string
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
  encoder?: TokenEncoder,
): string {
  // Tokens cannot be JSON; each is swapped for a sentinel string, then the
  // quoted sentinel is replaced by the host's encoding of that token.
  const tokens: string[] = []
  // Random per call so user data cannot collide with it.
  const SENTINEL = `island-token-${Math.random().toString(36).slice(2)}:`
  // Done before stringify: JSON.stringify calls `toJSON` ahead of the
  // replacer, and a token's `toJSON` may throw.
  const swap = (value: unknown): unknown => {
    if (!encoder) return value
    if (encoder.isToken(value)) {
      tokens.push(encoder.encode(value))
      return `${SENTINEL}${tokens.length - 1}`
    }
    if (Array.isArray(value)) return value.map(swap)
    if (typeof value === 'object' && value != null) {
      const proto = Object.getPrototypeOf(value)
      if (proto === Object.prototype || proto == null) {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, swap(v)]),
        )
      }
    }
    return value
  }
  let json: string
  try {
    json = JSON.stringify(swap(props), (key, value) => {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('[islands]')) throw error
    throw new Error(
      `[islands] <${label}> props could not be serialized: ${message}`,
    )
  }
  return tokens.length
    ? json.replace(
        new RegExp(`"${SENTINEL}(\\d+)"(\\}?)`, 'g'),
        // A space keeps a closing `}` off the end of the token: a template
        // placeholder like `{{x}}` followed by `}` would lex as `}}}`.
        (_m, i, brace) => tokens[+i]! + (brace ? ' }' : ''),
      )
    : json
}

/**
 * Content for the two situations in which a client-rendered island's marker
 * would otherwise be empty (the server has no component markup to put there):
 *
 *  - `placeholder`: the island has not begun to render. It holds the marker's
 *    place if the viewport sees it before the island's code has loaded. React
 *    clears the marker's children when the island mounts, so nothing has to
 *    remove it.
 *  - `noscript`: scripts are off, so the island will never render.
 *
 * What an island shows when it fails is the component's own business (an error
 * boundary of its own); the plugin adds no failed state.
 *
 * A server-rendered island already has its real markup, so it takes none.
 */
export interface IslandFallback {
  placeholder?: ReactNode
  noscript?: ReactNode
}

function fallbackNodes({ placeholder, noscript }: IslandFallback): ReactNode {
  return [
    placeholder != null &&
      createElement(
        'span',
        {
          key: 'placeholder',
          'data-island-placeholder': '',
          style: { display: 'contents' },
        },
        placeholder,
      ),
    noscript != null &&
      createElement('noscript', { key: 'noscript' }, noscript),
  ]
}

function containsToken(value: unknown, encoder: TokenEncoder): boolean {
  if (encoder.isToken(value)) return true
  if (Array.isArray(value)) return value.some((v) => containsToken(v, encoder))
  if (typeof value === 'object' && value != null) {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto == null) {
      return Object.values(value).some((v) => containsToken(v, encoder))
    }
  }
  return false
}

/** What the plugin's options add to each wrapped island. */
export interface WrapExtras {
  /** Handles props that are placeholders resolved later (see `TokenEncoder`). */
  encoder?: TokenEncoder
  /** This file's default loading conditions; a call's own `on*` props win. */
  defaultOn?: IslandOn
  /** Identifies the build the registry was made from; the client compares it. */
  build?: string
}

/**
 * Static content passed to an island as `children`. It is server-rendered into
 * the marker and handed to the component as a slot that the browser re-attaches
 * from the same HTML, so it never goes through React on the client: no tokens
 * resolved later in it, no interactivity.
 */
function Slot({ children }: { children?: ReactNode }): ReactNode {
  return createElement(
    'vite-slot',
    { suppressHydrationWarning: true, style: { display: 'contents' } },
    children,
  )
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
  extras: WrapExtras = {},
): T {
  if (!isComponent(value, exportName)) return value
  const { encoder, defaultOn, build } = extras

  const Original = value as unknown as ComponentType<any>
  const label =
    exportName === 'default'
      ? (Original.displayName ?? Original.name ?? 'default')
      : exportName

  function Island(allProps: Record<string, unknown>): ReactNode {
    const {
      fallback,
      children,
      slotAsFallback,
      slotAsNoScript,
      fallbackAsNoScript,
      ...withOn
    } = allProps as {
      fallback?: IslandFallback
      children?: ReactNode
      slotAsFallback?: boolean
      slotAsNoScript?: boolean
      fallbackAsNoScript?: boolean
    } & Record<string, unknown>
    for (const [name, value] of Object.entries({
      slotAsFallback,
      slotAsNoScript,
      fallbackAsNoScript,
    })) {
      if (value != null && typeof value !== 'boolean')
        throw new Error(
          `[islands] <${label}> ${name} must be true or false, got ` +
            `${JSON.stringify(value)}.`,
        )
    }
    // The loading conditions (onVisible, onIdle, ...) are for the marker, not
    // the component; the file's defaults apply unless the call says otherwise.
    const { rest: props, attrs: onAttrs } = splitOnProps(
      { ...defaultOn, ...withOn },
      label,
    )
    // Nested client component: the outer island already owns this subtree.
    if (useContext(InsideIsland))
      return createElement(
        Original,
        children != null ? { ...props, children } : props,
      )

    // Tokens only have values in the browser, so the server cannot render them.
    const hasToken =
      !!encoder && Object.values(props).some((v) => containsToken(v, encoder))
    const ssr = hydrate && !hasToken

    // The children are the visible placeholder when nothing else is.
    const slotIsPlaceholder =
      children != null && fallback == null && slotAsFallback !== false
    // What a visitor with scripts off gets instead of an island that will
    // never load: the call's own, else the children (already visible when they
    // are the placeholder, so nothing to add), else a copy of the placeholder.
    const noscript: ReactNode =
      fallback?.noscript ??
      (slotAsNoScript && children != null && !slotIsPlaceholder
        ? children
        : fallbackAsNoScript
          ? fallback?.placeholder
          : undefined)

    return createElement(
      'vite-island',
      {
        'data-island': id,
        'data-export': exportName,
        'data-props': serializeProps(props, label, encoder),
        'data-hydrate': ssr ? 'ssr' : 'client',
        ...onAttrs,
        ...(build ? { 'data-build': build } : {}),
        // `pending` until the client mounts the island, then `ready`.
        ...(ssr ? {} : { 'data-state': 'pending' }),
        // Lets CSS hide the placeholders when scripts are off (see NOSCRIPT_CSS).
        ...(!ssr && noscript != null ? { 'data-has-noscript': '' } : {}),
        // The marker is purely structural; keep it out of layout/CSS flow.
        style: { display: 'contents' },
      },
      ssr
        ? createElement(
            InsideIsland.Provider,
            { value: true },
            createElement(
              Original,
              children != null
                ? { ...props, children: createElement(Slot, null, children) }
                : props,
            ),
          )
        : [
            fallbackNodes({ placeholder: fallback?.placeholder, noscript }),
            children != null &&
              // With no fallback of its own the children ARE the placeholder:
              // visible from first paint (and with scripts off), cleared when
              // the island mounts. Otherwise they wait, inert, in a template.
              // Either way the client reads them from [data-island-slot].
              (slotIsPlaceholder
                ? createElement(
                    'span',
                    {
                      key: 'slot',
                      'data-island-placeholder': '',
                      'data-island-slot': '',
                      style: { display: 'contents' },
                    },
                    children,
                  )
                : createElement(
                    'template',
                    { key: 'slot', 'data-island-slot': '' },
                    children,
                  )),
          ],
    )
  }
  Island.displayName = `Island(${label})`
  return Island as unknown as T
}
