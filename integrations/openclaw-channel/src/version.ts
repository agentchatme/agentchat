/**
 * Single source of truth for the package version string.
 *
 * Kept as a hand-edited constant (not an `import ... from '../package.json'`)
 * so that tsup can bundle ESM/CJS without requiring `resolveJsonModule` +
 * runtime filesystem access from inside the published dist. A unit test
 * (`tests/version.test.ts`) pins this against `package.json` so bumping one
 * without the other fails CI.
 */
export const PACKAGE_VERSION = '0.2.0'
