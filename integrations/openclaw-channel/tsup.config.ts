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
    // Credential helper — emitted as its own dist file and kept
    // un-inlined into the main bundles via the `external` list below.
    // See SECURITY.md for the architectural rationale.
    'credentials/read-env': 'src/credentials/read-env.ts',
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
  external: [
    'openclaw',
    'openclaw/plugin-sdk/*',
    // Keep the credential helper as a separate runtime file (see
    // SECURITY.md). Both extensions listed because tsup matches the
    // literal import specifier; `scripts/fix-cjs-extensions.mjs`
    // post-processes the CJS bundle to swap `.js` for `.cjs` after
    // build so Node's CJS loader resolves to the sibling .cjs.
    './credentials/read-env.js',
    './credentials/read-env.cjs',
  ],
})
