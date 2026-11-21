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

| Option       | Default                        | Purpose                                                                                                                                                                 |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`    | `['src/**/*.{js,jsx,ts,tsx}']` | Where to look for `"use client"` modules. Only matched files can hydrate (the client registry comes from this scan, so client build doesn't depend on SSR build order). |
| `exclude`    | node_modules, `.d.ts`, tests   | Ignored paths.                                                                                                                                                          |
| `clientOnly` | none                           | `(file) => boolean`. Skip SSR for islands that touch `window` while rendering; client renders them from scratch.                                                        |

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
