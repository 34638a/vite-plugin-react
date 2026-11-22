/**
 * When an island's code loads and mounts: loading conditions, after
 * `<is-land>` (https://github.com/11ty/is-land) and its `on:` attributes.
 *
 * A call names conditions with `on*` props. With none, the island loads as soon
 * as the page's islands are hydrated. With several, ALL must be satisfied, as in
 * is-land; add `onAny` and ANY one is enough.
 *
 *     <Chart onVisible />                          when it scrolls into view
 *     <Chart onVisible="200px 0px" />              ...starting 200px early
 *     <Chart onIdle />                             gradually, when the browser is idle
 *     <Chart onIdle onVisible onAny />             idle's turn, or sooner if it is seen
 *     <Chart onInteraction="mouseenter,focusin" /> on first interaction
 *     <Chart onMedia="(min-width: 64em)" />        while the viewport matches
 *
 * The scheduler is logic over a small environment so it can be tested without
 * a browser; `browserEnv` is the real one.
 */

/** The loading-condition props of an island call. */
export interface IslandOn {
  /** Loads when it is on screen. A string is the observer's `rootMargin` (`"200px 0px"`). */
  onVisible?: boolean | string
  /**
   * Loads gradually: one island per idle slice of the browser, after the page
   * has loaded. A number is the longest wait (ms) for its turn.
   */
  onIdle?: boolean | number
  /** Loads once the page's `load` event has fired. */
  onLoad?: boolean
  /** Loads on first interaction. A string is a comma-separated event list (default `touchstart,click`). */
  onInteraction?: boolean | string
  /** Loads while this media query matches (`"(min-width: 64em)"`, `"(prefers-reduced-motion)"`). */
  onMedia?: string
  /** `true`: only while Save Data is on. `false`: only while it is off. */
  onSaveData?: boolean
  /** Any one condition is enough, instead of all of them. */
  onAny?: boolean
}

export type LoadCondition =
  | { on: 'visible'; rootMargin?: string }
  | { on: 'idle'; timeout?: number }
  | { on: 'load' }
  | { on: 'interaction'; events?: string[] }
  | { on: 'media'; query: string }
  | { on: 'saveData'; expected: boolean }

/** The `on*` prop names; each becomes a `data-on-*` attribute on the marker. */
const ON_PROPS = [
  'onVisible',
  'onIdle',
  'onLoad',
  'onInteraction',
  'onMedia',
  'onSaveData',
  'onAny',
] as const

const kebab = (name: string) =>
  name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/**
 * Server side: splits the `on*` props off an island call and validates them.
 *
 * @returns the remaining props, and the marker attributes the conditions
 *          become (`onSaveData` -> `data-on-save-data`). `true` is a bare
 *          attribute; `false` adds nothing, except for `onSaveData`, where it
 *          means "while Save Data is off".
 */
export function splitOnProps(
  props: Record<string, unknown>,
  label: string,
): { rest: Record<string, unknown>; attrs: Record<string, string> } {
  const rest = { ...props }
  const attrs: Record<string, string> = {}
  const bad = (name: string, expected: string): never => {
    throw new Error(
      `[islands] <${label}> ${name} must be ${expected}, got ` +
        `${JSON.stringify(props[name])}.`,
    )
  }
  const text = (v: unknown): v is string => typeof v === 'string' && v !== ''

  for (const name of ON_PROPS) {
    if (!(name in rest)) continue
    const value = props[name]
    delete rest[name]
    if (value == null) continue
    const attr = 'data-' + kebab(name)

    switch (name) {
      case 'onVisible':
      case 'onInteraction':
        if (value === true) attrs[attr] = ''
        else if (text(value)) attrs[attr] = value
        else if (value !== false) bad(name, 'true or a non-empty string')
        break
      case 'onIdle':
        if (value === true) attrs[attr] = ''
        else if (typeof value === 'number' && value > 0 && isFinite(value))
          attrs[attr] = String(value)
        else if (value !== false) bad(name, 'true or a positive number')
        break
      case 'onLoad':
      case 'onAny':
        if (value === true) attrs[attr] = ''
        else if (value !== false) bad(name, 'true')
        break
      case 'onMedia':
        if (text(value)) attrs[attr] = value
        else bad(name, 'a media query string')
        break
      case 'onSaveData':
        if (value === true) attrs[attr] = ''
        else if (value === false) attrs[attr] = 'false'
        else bad(name, 'true or false')
        break
    }
  }
  return { rest, attrs }
}

/** Browser side: the conditions a marker's `data-on-*` attributes describe. */
export function readConditions(data: DOMStringMap): {
  conditions: LoadCondition[]
  any: boolean
} {
  const conditions: LoadCondition[] = []
  if (data.onVisible !== undefined)
    conditions.push({
      on: 'visible',
      ...(data.onVisible ? { rootMargin: data.onVisible } : {}),
    })
  if (data.onIdle !== undefined) {
    const timeout = Number(data.onIdle)
    conditions.push({ on: 'idle', ...(timeout > 0 ? { timeout } : {}) })
  }
  if (data.onLoad !== undefined) conditions.push({ on: 'load' })
  if (data.onInteraction !== undefined)
    conditions.push({
      on: 'interaction',
      ...(data.onInteraction
        ? {
            events: data.onInteraction
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean),
          }
        : {}),
    })
  if (data.onMedia !== undefined)
    conditions.push({ on: 'media', query: data.onMedia })
  if (data.onSaveData !== undefined)
    conditions.push({ on: 'saveData', expected: data.onSaveData !== 'false' })
  return { conditions, any: data.onAny !== undefined }
}

/** One loading condition in flight: it settles when satisfied, and can be abandoned. */
export interface Condition {
  promise: Promise<void>
  cancel(): void
}

export interface SchedulerEnv {
  /** Resolves once the page's `load` event has fired. */
  pageLoaded(): Promise<void>
  /** Calls `callback` once, in a later idle slice of the browser. */
  requestIdle(callback: () => void): void
  /** Calls `callback` after `ms`; returns a function that cancels it. */
  delay(ms: number, callback: () => void): () => void
  visible(targets: Element[], rootMargin?: string): Condition
  interaction(target: Element, events: string[]): Condition
  media(query: string): Condition
  saveData(expected: boolean): Condition
}

/** Starts one island; resolves when it is mounted. */
type Start = () => Promise<void> | void

export function createScheduler(env: SchedulerEnv) {
  // Islands waiting for an idle slice, in the order they asked. A cancelled
  // entry (loaded some other way, or timed out) is skipped without using up a slice.
  const queue: Array<{ resolve: () => void; cancelled: boolean }> = []
  let draining = false

  function drain() {
    if (draining) return
    draining = true
    env.requestIdle(() => {
      draining = false
      let next = queue.shift()
      while (next?.cancelled) next = queue.shift()
      next?.resolve()
      if (queue.length) drain()
    })
  }

  function idle(timeout?: number): Condition {
    const entry = { resolve: () => {}, cancelled: false }
    let clearTimer: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
      entry.resolve = () => {
        clearTimer?.()
        resolve()
      }
      // Idle time is for after the page has loaded, not competing with it.
      void env.pageLoaded().then(() => {
        if (entry.cancelled) return
        queue.push(entry)
        drain()
        if (timeout)
          clearTimer = env.delay(timeout, () => {
            entry.cancelled = true
            entry.resolve()
          })
      })
    })
    return {
      promise,
      cancel: () => {
        entry.cancelled = true
        clearTimer?.()
      },
    }
  }

  function build(
    condition: LoadCondition,
    ctx: { marker: Element; targets: Element[] },
  ): Condition {
    switch (condition.on) {
      case 'visible':
      case 'interaction':
        if (ctx.targets.length === 0) {
          console.warn(
            `[islands] on${condition.on === 'visible' ? 'Visible' : 'Interaction'} ` +
              `needs the island to have content with a layout box (its server ` +
              `markup or a placeholder) to watch; it has none, so it waits for ` +
              `an idle turn instead.`,
          )
          return idle()
        }
        return condition.on === 'visible'
          ? env.visible(ctx.targets, condition.rootMargin)
          : env.interaction(
              ctx.marker,
              condition.events ?? ['touchstart', 'click'],
            )
      case 'idle':
        return idle(condition.timeout)
      case 'load':
        return { promise: env.pageLoaded(), cancel: () => {} }
      case 'media':
        return env.media(condition.query)
      case 'saveData':
        return env.saveData(condition.expected)
    }
  }

  /**
   * @param conditions what must happen before the island loads (none: now)
   * @param any        any one condition is enough, instead of all of them
   * @param ctx        the marker, and the elements with a layout box to watch
   *                   (the marker itself has none: it is `display: contents`)
   * @returns the start result when there are no conditions, nothing otherwise
   *          (a visible or interaction island may never load, so nothing waits on it)
   */
  return function schedule(
    conditions: LoadCondition[],
    any: boolean,
    ctx: { marker: Element; targets: Element[] },
    start: Start,
  ): Promise<void> | void {
    if (conditions.length === 0) return start()

    let started = false
    const built = conditions.map((condition) => build(condition, ctx))
    const go = () => {
      if (started) return
      started = true
      for (const condition of built) condition.cancel()
      void start()
    }
    const promises = built.map((condition) => condition.promise)
    void (any ? Promise.race(promises) : Promise.all(promises)).then(go)
  }
}

/** The elements to watch for an island: the top-most descendants with a box. */
export function observableTargets(marker: Element): Element[] {
  if (marker.getClientRects().length > 0) return [marker]
  const found: Element[] = []
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (child.getClientRects().length > 0) found.push(child)
      else visit(child)
    }
  }
  visit(marker)
  return found
}

/** Idle slices are bounded so a busy page cannot starve the queue forever. */
const IDLE_SLICE_TIMEOUT_MS = 2000

const satisfied = (): Condition => ({
  promise: Promise.resolve(),
  cancel: () => {},
})

let pageLoaded: Promise<void> | undefined

export const browserEnv: SchedulerEnv = {
  pageLoaded: () =>
    (pageLoaded ??= new Promise<void>((resolve) => {
      if (document.readyState === 'complete') resolve()
      else window.addEventListener('load', () => resolve(), { once: true })
    })),

  requestIdle: (callback) =>
    typeof requestIdleCallback === 'function'
      ? void requestIdleCallback(() => callback(), {
          timeout: IDLE_SLICE_TIMEOUT_MS,
        })
      : void setTimeout(callback, 50), // Safari has no requestIdleCallback

  delay: (ms, callback) => {
    const id = setTimeout(callback, ms)
    return () => clearTimeout(id)
  },

  visible: (targets, rootMargin) => {
    if (typeof IntersectionObserver === 'undefined') return satisfied()
    let observer: IntersectionObserver | undefined
    const promise = new Promise<void>((resolve) => {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          resolve()
        },
        rootMargin ? { rootMargin } : undefined,
      )
      for (const target of targets) observer.observe(target)
    })
    return { promise, cancel: () => observer?.disconnect() }
  },

  interaction: (target, events) => {
    let listener: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
      listener = () => {
        for (const name of events) target.removeEventListener(name, listener!)
        resolve()
      }
      for (const name of events)
        target.addEventListener(name, listener, { once: true, passive: true })
    })
    return {
      promise,
      cancel: () => {
        for (const name of events) target.removeEventListener(name, listener!)
      },
    }
  },

  media: (query) => {
    if (typeof matchMedia === 'undefined') return satisfied()
    const list = matchMedia(query)
    if (list.matches) return satisfied()
    let onChange: ((event: MediaQueryListEvent) => void) | undefined
    const promise = new Promise<void>((resolve) => {
      onChange = (event) => {
        if (!event.matches) return
        list.removeEventListener('change', onChange!)
        resolve()
      }
      list.addEventListener('change', onChange)
    })
    return {
      promise,
      cancel: () => list.removeEventListener('change', onChange!),
    }
  },

  saveData: (expected) => {
    const connection = (
      window.navigator as { connection?: { saveData?: boolean } }
    ).connection
    // Without the API there is nothing to wait for. With it, a mismatch never loads.
    if (!connection || !!connection.saveData === expected) return satisfied()
    return { promise: new Promise<void>(() => {}), cancel: () => {} }
  },
}
