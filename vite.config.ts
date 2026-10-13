import { defineConfig } from 'vite';

// The site is served from https://<user>.github.io/sky-builder/ (BRIEF §11).
export default defineConfig({
  base: '/sky-builder/',
  build: {
    // Three.js alone is about 540 kB (140 kB gzipped). One file is fine for a single-page tool (PLAN §15.3).
    chunkSizeWarningLimit: 800,
  },
});
