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
    // AGENTS.md anchor module — emitted as its own dist file so the
    // workspace-file write logic stays in a module that only touches
    // the local filesystem. See SECURITY.md for the architectural
    // rationale.
    'binding/agents-anchor': 'src/binding/agents-anchor.ts',
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
    // Credential helper — both source-relative variants listed because
    // tsup matches the LITERAL import specifier:
    //   - entries in src/                use './credentials/...'
    //   - entries in src/binding/        use '../credentials/...'
    // Both `.js` and `.cjs` listed because `scripts/fix-cjs-extensions.mjs`
    // post-processes the CJS bundles to swap `.js` for `.cjs` after
    // build so Node's CJS loader resolves to the sibling .cjs file.
    './credentials/read-env.js',
    './credentials/read-env.cjs',
    '../credentials/read-env.js',
    '../credentials/read-env.cjs',
    // AGENTS.md anchor — kept as its own runtime file. Consumers in
    // src/ import './binding/agents-anchor.js'; no parent-relative
    // variant exists in the source tree today.
    './binding/agents-anchor.js',
    './binding/agents-anchor.cjs',
  ],
})
