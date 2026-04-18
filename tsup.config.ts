import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Inject the package version at build time so `VERSION` (and the default
// User-Agent header) stay in lockstep with package.json without a separate
// sync script. Tests import `src/version.ts` directly and hit the runtime
// fallback (`'0.0.0-dev'`) — good enough for assertion stability.
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string }

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  // Emit `.cjs` for the CJS entry so the conditional exports map is
  // unambiguous under both `"type": "module"` and `"type": "commonjs"`
  // consumers. Without this, tsup emits `index.js` for both formats when
  // the package has `"type": "module"`, and Node's resolver picks the ESM
  // file under `require()` — which breaks CommonJS consumers.
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  treeshake: true,
  splitting: false,
  minify: false,
})
