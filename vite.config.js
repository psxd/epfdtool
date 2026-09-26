import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base path ensures assets load cleanly on GitHub Pages
  base: './',
  // Force a single copy of three.js. globe.gl ships its own nested three;
  // without dedupe, Vite pre-bundles two copies and the render loop crashes
  // with "object2.intersectsFrustum is not a function" (mixed-revision scene graph).
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three', 'globe.gl', 'satellite.js'],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: true, // Automatically opens your browser when running 'npm run dev'
  },
});