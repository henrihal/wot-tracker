import { defineConfig, loadEnv } from 'vite'

// Dev proxy: the browser calls same-origin `/api/*`, and Vite forwards
// those to the wot-stat-server (default http://localhost:3001) with the
// `/api` prefix stripped. This sidesteps CORS entirely in dev.
//
// Set `WOT_API_TARGET` in server/.env (or repo .env) to point elsewhere.
//
// Prod: either serve the built UI from the same origin as the API, or put
// a reverse proxy in front that maps `/api/*` -> the API. The default base
// is the relative `/api`, so no env var is needed for the common case.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.WOT_API_TARGET || 'http://localhost:3001'

  return {
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
