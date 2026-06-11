import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    fs: {
      // engine.wasm and the demo project live outside the app root
      allow: ['../..'],
    },
  },
  build: {
    target: 'es2022',
  },
});
