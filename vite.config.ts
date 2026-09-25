import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

/** Path aliases, mirrored in the tsconfig `paths` of each folder (and reused by vitest.config.ts). */
export const aliases = {
  '@shared': path.join(root, 'shared'),
  '@server': path.join(root, 'server'),
  '@web': path.join(root, 'web'),
};

const API_TARGET = 'http://127.0.0.1:3000';

export default defineConfig({
  root: path.join(root, 'web'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
  build: {
    outDir: path.join(root, 'dist', 'web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET },
      '/mcp': { target: API_TARGET },
      '/healthz': { target: API_TARGET },
    },
  },
});
