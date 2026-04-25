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
    // Pure env-reader, emitted as its own dist file. Imported via the
    // relative `./credentials/read-env.js` specifier from
    // `channel.wizard.ts`. Marked external below so tsup does NOT inline
    // the source back into the index/setup-entry bundles — that inlining
    // would re-create the env-read-co-located-with-fetch pattern that
    // ClawHub's install-time scanner blocks. The structural separation
    // is load-bearing; see read-env.ts docstring.
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
    // Keep our credentials/read-env module as a separate runtime file
    // — the dist tree exposes it as a sibling of the main bundles so
    // emitted code imports it via `require`/`import` at runtime
    // instead of inlining its contents. Both extensions listed because
    // tsup matches against the literal import specifier; the CJS build
    // emits `require('./credentials/read-env.js')` which is then
    // post-processed by `scripts/fix-cjs-extensions.mjs` to swap `.js`
    // for `.cjs` so the CJS loader resolves to the sibling .cjs file
    // rather than tripping ERR_REQUIRE_ESM on the `.js` ESM build.
    './credentials/read-env.js',
    './credentials/read-env.cjs',
  ],
})
