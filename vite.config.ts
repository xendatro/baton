import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;

/** Path aliases, mirrored in the tsconfig `paths` of each folder (and reused by vitest.config.ts). */
export const aliases = {
  '@shared': path.join(root, 'shared'),
  '@server': path.join(root, 'server'),
  '@web': path.join(root, 'web'),
};

const API_TARGET = 'http://127.0.0.1:3000';

/** Where the web build's source maps go: next to dist/web, never inside the served folder. */
export const WEB_SOURCEMAP_DIR = path.join(root, 'dist', 'sourcemaps', 'web');

/**
 * Keeps the web source maps out of `dist/web`, which the server publishes: they carry the whole
 * web source (`sourcesContent`). The build writes them `hidden` (no `sourceMappingURL` comment),
 * and this moves them to `dist/sourcemaps/web/` for debugging production stack traces locally.
 */
function privateSourceMaps(): Plugin {
  return {
    name: 'baton:private-sourcemaps',
    apply: 'build',
    writeBundle(options, bundle) {
      if (!options.dir) return;
      fs.rmSync(WEB_SOURCEMAP_DIR, { recursive: true, force: true });
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith('.map')) continue;
        const target = path.join(WEB_SOURCEMAP_DIR, fileName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(path.join(options.dir, fileName), target);
      }
    },
  };
}

/**
 * Vendor code in chunks of its own. The entry chunk's libraries (React, the router, zod, TanStack
 * Query) load on every page: split out, the entry stays under Vite's 500 kB warning and a deploy
 * that only changes app code leaves them cached. Syntax highlighting (lowlight, highlight.js) is
 * shared by the editor and MarkdownView. (Tiptap and ProseMirror stay in the editor's lazy chunk:
 * grouping them apart changed their evaluation order and broke the editor at runtime.)
 */
const VENDOR_CHUNKS = [
  { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
  { name: 'vendor-router', test: /node_modules[\\/]react-router[\\/]/ },
  { name: 'vendor-zod', test: /node_modules[\\/]zod[\\/]/ },
  { name: 'vendor-query', test: /node_modules[\\/]@tanstack[\\/]/ },
  { name: 'vendor-highlight', test: /node_modules[\\/](lowlight|highlight\.js)[\\/]/ },
];

export default defineConfig({
  root: path.join(root, 'web'),
  plugins: [react(), tailwindcss(), privateSourceMaps()],
  resolve: { alias: aliases },
  build: {
    outDir: path.join(root, 'dist', 'web'),
    emptyOutDir: true,
    sourcemap: 'hidden',
    rolldownOptions: {
      output: {
        codeSplitting: { groups: VENDOR_CHUNKS },
      },
    },
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
