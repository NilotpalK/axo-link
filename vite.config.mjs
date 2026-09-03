import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export const DEV_SERVER_PORT = 5273;

export default defineConfig({
  root: 'src/renderer',
  // Electron loads the built bundle over file://, where absolute asset paths 404.
  base: './',
  plugins: [react(), tailwindcss()],
  server: { port: DEV_SERVER_PORT, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
