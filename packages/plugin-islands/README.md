# @vitejs/plugin-islands

Islands / partial hydration for static React pages, built on the `"use client"`
boundary detection and export-rewriting transforms of
[`@vitejs/plugin-rsc`](../plugin-rsc) — **without** React Server Components,
the Flight protocol, or a running server.

Your pipeline renders pages to static HTML (Apache + PHP in our case). This
plugin makes the interactive parts of those pages come back to life in the
browser.

## How the modules are split

| Module kind    | Server (SSR) build                                    | Client build                                  |
| -------------- | ----------------------------------------------------- | --------------------------------------------- |
| _no directive_ | Rendered to static HTML                               | Not bundled (unless an island imports it)     |
| `"use client"` | Rendered to HTML **and** wrapped in a `<vite-island>` | Own lazy chunk, listed in the island registry |
| `"use server"` | Untouched (server only)                               | **Build error** — see below                   |

### `"use server"` is not "render on the server"

In React, `"use server"` marks server _actions_ (functions the browser calls
over RPC). Components that render on the server need **no directive at all**.
A static-HTML host has no action endpoint, so a `"use server"` module reaching
the client bundle is always a mistake and fails the build instead of silently
leaking server code. Leave server modules undirected (or `"use server"` if you
like) and keep them out of `"use client"` import graphs.

## Usage

```ts
// vite.config.ts
import { islands } from '@vitejs/plugin-islands'

export default {
  plugins: [islands()],
  // build the SSR environment, then the client environment
  builder: {
    async buildApp(b) {
      await b.build(b.environments.ssr)
      await b.build(b.environments.client)
    },
  },
}
```

```js
// main.js — the client entry. One import hydrates every island on the page.
import 'virtual:islands/client'
```

```tsx
// Counter.tsx
'use client'
export function Counter({ start }: { start: number }) {
  /* useState, handlers… */
}
```

Using `<Counter start={3} />` from any server module now renders:

```html
<vite-island
  data-island="a1b2c3d4"
  data-export="Counter"
  data-props='{"start":3}'
  data-hydrate="ssr"
  style="display:contents"
>
  <button>Count: 3</button>
</vite-island>
```

and the client runtime loads only that island's chunk, then `hydrateRoot`s the
marker.

## Options

| Option         | Default                        | Purpose                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`      | `['src/**/*.{js,jsx,ts,tsx}']` | Where to look for `"use client"` modules. Only matched files can hydrate (the client registry comes from this scan, so client build doesn't depend on SSR build order).                                                                                                    |
| `exclude`      | node_modules, `.d.ts`, tests   | Ignored paths.                                                                                                                                                                                                                                                             |
| `clientOnly`   | none                           | `(file) => boolean`. Skip SSR for islands that touch `window` while rendering; client renders them from scratch.                                                                                                                                                           |
| `tokenEncoder` | none                           | Module specifier whose default export is `{ isToken(v), encode(v) }`. A host (e.g. a template engine) passes props that are placeholders resolved later; `encode` returns the JSON fragment spliced into `data-props`. An island with such a prop is client-rendered only. |

## When an island loads (`on*` props)

Loading conditions are modelled on [`<is-land>`](https://github.com/11ty/is-land)
and its `on:` attributes. With none, an island loads as soon as the page's
islands are hydrated. Name conditions with reserved `on*` props; they become
`data-on-*` attributes on the marker and never reach the component.

| Prop            | Value                                      | The island loads…                                                                                                     |
| --------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `onVisible`     | `true`, or a `rootMargin` (`"200px 0px"`)  | when it is on screen (the margin starts it early).                                                                    |
| `onIdle`        | `true`, or a max wait in ms                | gradually: one island per browser idle slice, in document order, after the page has loaded. A number bounds its wait. |
| `onLoad`        | `true`                                     | once the page's `load` event has fired.                                                                               |
| `onInteraction` | `true`, or events (`"mouseenter,focusin"`) | on first interaction with it (default `touchstart,click`). The triggering event is not replayed.                      |
| `onMedia`       | a media query                              | while the query matches (`"(min-width: 64em)"`, `"(prefers-reduced-motion)"`).                                        |
| `onSaveData`    | `true` or `false`                          | while Save Data is on (`true`) or off (`false`).                                                                      |
| `onAny`         | `true`                                     | (a combinator, see below)                                                                                             |

**Several conditions must ALL be satisfied**, as in is-land:
`<Map onVisible onMedia="(min-width: 64em)" />` loads when it is on screen on a
wide viewport. Add `onAny` and **any one** is enough:

```tsx
// Trickle in when idle, but right now if the visitor reaches it first.
<Chart onIdle onVisible onAny />
```

The idle queue is shared, so `onIdle` islands start one at a time. An island that
loads another way (here, by becoming visible) is dropped from the queue and its
turn is skipped, not wasted.

- `onVisible` and `onInteraction` need content to watch with a layout box: the
  server markup, or a `fallback.placeholder`. The marker itself is
  `display: contents` and has none. An island with nothing to watch logs a
  warning and waits for an idle turn instead.
- Browsers without `requestIdleCallback` (Safari) fall back to a short timer;
  each idle slice is otherwise bounded by a 2s timeout so a busy page cannot
  starve the queue.
- `onSaveData` without the Network Information API counts as satisfied;
  `onMedia` without `matchMedia` too.
- `hydrateIslands()` resolves when the islands with no conditions have mounted;
  the others are only scheduled by then, since e.g. a visible one may never load.
- Invalid values (`onMedia` as a boolean, `onIdle="soon"`, …) fail the render,
  naming the component and the prop.
- These prop names are reserved on an island call, so a component should not
  use them for its own props.

## Placeholder and no-JS content (`fallback`)

A client-rendered island (one with a token prop, or listed in `clientOnly`) has
no component markup on the server, so its marker would be empty until the island
mounts. Pass the reserved `fallback` prop to fill it:

```tsx
<Widget
  fallback={{ placeholder: <Skeleton />, noscript: <p>Enable JavaScript</p> }}
/>
```

- `placeholder`: "this island has not begun to render yet". It holds the
  marker's place in case the viewport sees it before the island's code has
  loaded. React replaces it when the island mounts.
- `noscript`: "this island will never render, scripts are off". Inside
  `<noscript>`. The placeholder is still visible with scripts off too; hide it
  with CSS on `[data-island-placeholder]` if that matters.

There is no failed state. What an island shows when it breaks is the
component's own business (give it an error boundary). If an island's module
cannot load, the error is logged and the placeholder stays.

`fallback` is never serialized and never reaches the component. A
server-rendered island has its real markup already, so it takes none.

The marker's `data-state` is `pending` on a client-rendered island until it
mounts, then `ready`.

## Development

- **Fast Refresh in place.** In dev the client entry installs
  `@vitejs/plugin-react`'s refresh preamble (when that plugin is present), so
  editing an island's code hot-updates it and keeps its state. The plugin also
  points Fast Refresh's self-import at a `/@fs/` URL, for hosts that answer
  root-relative `/src/...` URLs themselves.
- **Restart on new props.** If a marker's `data-props` changes, its island is
  unmounted and mounted again with fresh state and the new props.

## Rules and limitations

- **Props must be JSON.** Functions, symbols, bigint, class instances and React
  elements throw at render time with the component name. `Date` becomes a
  string (JSON semantics).
- **No `children` on islands (yet).** React elements can't be serialized into
  an attribute; passing them throws a clear error.
- **Nested client components** are fine: only the outermost one gets a marker.
- **Only component exports become islands** (capitalised names, default
  exports, `memo`/`forwardRef`/`lazy`). Hooks, constants and helpers exported
  from a `"use client"` file pass through unchanged.
- `export *` in a `"use client"` module is rejected (same limitation as
  plugin-rsc's wrap transform).
- `"use client"` modules from `node_modules` are not scanned; wrap them in a
  local `"use client"` file.
- Hydration is eager (on load). Lazy strategies (visible/idle) are not
  implemented.
- Dev server: registry updates on file add/remove; the SSR rendering side is
  whatever your pipeline does. The e2e test covers production builds only.

## Development

```bash
pnpm --filter @vitejs/plugin-rsc build   # transforms dependency
pnpm --filter @vitejs/plugin-islands build
pnpm --filter @vitejs/plugin-islands test --run
```

The integration test launches Chromium; set `CHROMIUM_PATH` if the Playwright
browser revision isn't installed.
