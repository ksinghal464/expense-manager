import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Frontend dev server proxies API calls to a local `wrangler dev` worker.
      '/api': 'http://localhost:8787',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
