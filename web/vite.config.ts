import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El panel se compila a web/dist y es servido por Fastify (@fastify/static)
// desde el mismo contenedor/puerto. En dev, Vite hace proxy a la API.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/health': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
