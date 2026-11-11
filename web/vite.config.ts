import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': { target: process.env.KB_PREVIEW_API ?? 'http://127.0.0.1:4174', changeOrigin: true } } },
});
