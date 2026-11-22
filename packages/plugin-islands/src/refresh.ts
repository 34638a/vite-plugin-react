/**
 * `@vitejs/plugin-react` ends every refreshable module with a self-import
 * addressed by the module's root-relative URL:
 *
 *     import * as __vite_react_currentExports from "/src/client/Counter.tsx"
 *
 * A host that owns root-relative URLs (Stencil's dev server answers `/src/...`
 * with a storefront page) breaks that import, and with it the island's module.
 * `/@fs/` URLs always reach Vite, and name the same module.
 */
const SELF_IMPORT =
  /(import \* as __vite_react_currentExports from )(["'])[^"']+\2/

export function rewriteRefreshSelfImport(code: string, file: string): string {
  return code.replace(
    SELF_IMPORT,
    (_m, head: string, quote: string) =>
      `${head}${quote}/@fs/${file.replace(/^\//, '')}${quote}`,
  )
}
