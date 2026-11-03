import { defineConfig } from 'vite';
const publicDemo = process.env.VITE_PUBLIC_DEMO === 'true';
export default defineConfig({
  base: publicDemo ? (process.env.BUGARCADE_PUBLIC_BASE || '/bugarcade/') : '/',
  build: { outDir: publicDemo ? 'dist-hosted' : 'dist' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
    watch: { ignored: ['**/evidence/**', '**/.data/**', '**/.venv/**', '**/work/**', '**/__pycache__/**', '**/dist-submission/**', '**/evaluation/**', '**/.design-tools/**', '**/.hallmark/**'] },
  },
  preview: { port: 5173, strictPort: true },
});
