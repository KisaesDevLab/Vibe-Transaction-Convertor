import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production builds bake in a sentinel base path so a single image can
// serve either '/' (single-app standalone deploy) or '/<prefix>/'
// (multi-app behind the Vibe-Appliance shared Caddy with path-prefix
// routing in LAN / Tailscale modes). scripts/web-base-path.sh
// substitutes /__VIBE_BASE_PATH__/ with $VITE_BASE_PATH across the
// built assets at container start. Same pattern as sibling apps —
// see Vibe-Trial-Balance/deploy/web-entrypoint.sh and Vibe-Appliance
// lib/enable-app.sh (lines 683-687) for the contract.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/__VIBE_BASE_PATH__/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
}));
