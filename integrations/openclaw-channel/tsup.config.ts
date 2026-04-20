import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'setup-entry': 'src/setup-entry.ts',
    'configured-state': 'src/configured-state.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
  treeshake: true,
  splitting: false,
  minify: false,
  external: ['openclaw', 'openclaw/plugin-sdk/*'],
})
