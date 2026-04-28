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
    // SECURITY.md). All four source-relative variants listed because
    // tsup matches the LITERAL import specifier — entries in src/
    // use './credentials/...' and entries in src/binding/ use
    // '../credentials/...'. Both extensions listed because
    // `scripts/fix-cjs-extensions.mjs` post-processes the CJS bundle
    // to swap `.js` for `.cjs` after build so Node's CJS loader
    // resolves to the sibling .cjs.
    //
    // Load-bearing: any import path that's NOT in this list will be
    // inlined into the consumer's bundle, dragging `process.env`
    // alongside it and re-tripping OpenClaw's `env-harvesting`
    // install scanner. Add new variants as soon as a new entry path
    // depth is introduced.
    './credentials/read-env.js',
    './credentials/read-env.cjs',
    // Note: `../credentials/...` variants are NOT here on purpose —
    // they're handled by the esbuildPlugin below which both marks
    // them external AND rewrites them to `./credentials/...` so the
    // post-bundle import resolves from `dist/` correctly.
  ],
  esbuildPlugins: [
    {
      // Rewrite parent-relative imports of the credential helper to
      // sibling-relative ones at bundle output time. Reason: source
      // code in src/binding/ uses `../credentials/read-env.js`
      // (correct for source-time TS resolution), but after tsup
      // inlines src/binding/* into dist/index.js (a sibling of
      // dist/credentials/), the surviving external import needs to
      // resolve from `dist/`. Without this, the literal preserved
      // path would point to `dist/../credentials/...` which is wrong.
      name: 'rewrite-credentials-relative-path',
      setup(build) {
        build.onResolve(
          { filter: /^\.\.\/credentials\/read-env\.(js|cjs)$/ },
          (args) => ({
            path: args.path.replace(/^\.\.\//, './'),
            external: true,
          }),
        )
      },
    },
  ],
})
