import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { knowledgeApiPlugin } from './dev-api.js';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue(), knowledgeApiPlugin()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5183, strictPort: true,
    // 开发源码只开放页面、依赖和共享Markdown渲染器，不直接暴露业务库或整个仓库。
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../node_modules', import.meta.url)), fileURLToPath(new URL('../src/preview/markdown.ts', import.meta.url))] },
  },
});
