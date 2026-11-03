import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
    watch: { ignored: ['**/evidence/**', '**/.data/**', '**/.venv/**', '**/work/**', '**/__pycache__/**', '**/dist-submission/**', '**/evaluation/**', '**/.design-tools/**', '**/.hallmark/**'] },
  },
  preview: { port: 5173, strictPort: true },
});
