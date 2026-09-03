import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    // 绑定所有网卡（含 IPv4 回环）：避免仅监听 [::1] 时 Firefox 等按 IPv4 解析 localhost 的连接失败
    host: true,
    proxy: {
      '/api': 'http://localhost:7980',
      '/ws': {
        target: 'http://localhost:7980',
        ws: true,
      },
    },
    watch: {
      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    },
  },
});
