import { defineConfig } from 'tsdown'

export default defineConfig({
  // The plugin (build-time, Node) and the two runtimes (shipped into the SSR
  // bundle and the browser bundle respectively) are separate entry points so
  // that browser code never pulls in Node-only plugin code and vice versa.
  entry: ['src/index.ts', 'src/runtime/server.ts', 'src/runtime/client.ts'],
  format: ['esm'],
  fixedExtension: false,
  dts: true,
  deps: {
    neverBundle: [/^virtual:/],
  },
}) as any
