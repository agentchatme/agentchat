// Tailwind v4 runs as a PostCSS plugin, invoked once per Next.js build.
// No separate tailwind.config.ts — v4 is CSS-first and reads its theme
// tokens directly from `src/app/globals.css` via the @theme directive.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
