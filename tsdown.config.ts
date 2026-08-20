import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
  },
  format: 'esm',
  outDir: 'lib',
  clean: false,
  dts: false,
  external: [/^@deepseek-ai\//],
})
