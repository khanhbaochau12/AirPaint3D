import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

// HTTPS chỉ cần khi test trên điện thoại qua LAN (camera + WebXR yêu cầu
// secure context; localhost được miễn). Bật bằng: npm run dev:https
export default defineConfig(({ mode }) => ({
  plugins: mode === 'https' ? [basicSsl()] : [],

  server: {
    port: 5173,
    host: true,   // expose ra LAN để test trên mobile
  },

  build: {
    rollupOptions: {
      input: {
        portfolio: fileURLToPath(new URL('./index.html', import.meta.url)),
        app:       fileURLToPath(new URL('./app.html',   import.meta.url)),
      },
    },
  },
}));
