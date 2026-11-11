import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

import { fileURLToPath } from 'node:url';
const backendDir = fileURLToPath(new URL('../backend/', import.meta.url));
const port = loadEnv('development', backendDir, 'PORT').PORT || '3000';
const apiTarget = process.env.VITE_API_PROXY_TARGET || loadEnv('development', process.cwd()).VITE_API_PROXY_TARGET || ('http://localhost:' + port);

// Vite 配置
// - 开发时 /api 代理到本地后端 3000
// - 打包输出到 dist（前端独立部署）
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  }
});
