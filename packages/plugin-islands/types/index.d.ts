// Ambient types for the virtual modules provided by @vitejs/plugin-islands.
// Reference from your app with:  /// <reference types="@vitejs/plugin-islands/types" />

declare module 'virtual:islands/registry' {
  /** island id -> lazy loader for that island's client module */
  const registry: Record<string, () => Promise<Record<string, unknown>>>
  export default registry
}

declare module 'virtual:islands/client' {
  import type { IslandRegistry } from '@vitejs/plugin-islands/runtime/client'
  /** Re-hydrate islands inside dynamically inserted HTML. */
  export function hydrateIslands(
    registry: IslandRegistry,
    root?: ParentNode,
  ): Promise<void[]>
  export const registry: IslandRegistry
}

// Custom element emitted by the SSR runtime.
declare namespace JSX {
  interface IntrinsicElements {
    'vite-island': Record<string, unknown>
  }
}
