import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento, /api é encaminhado para a API (login por sessão, cookie HttpOnly).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxy = env.SYNCLEAD_API_URL
    ? {
        '/api': { target: env.SYNCLEAD_API_URL, changeOrigin: true },
      }
    : undefined;

  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { proxy },
  };
});
