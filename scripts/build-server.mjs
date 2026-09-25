// Bundles the server (server/index.ts → dist/server/index.js) and copies the SQL migrations next
// to it. npm packages stay external: production runs from a checkout with node_modules installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist', 'server');

fs.rmSync(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  // The bundle defaults NODE_ENV to production (see loadEnv in server/index.ts).
  define: { BATON_BUNDLE_NODE_ENV: '"production"' },
  legalComments: 'none',
  logLevel: 'info',
});

fs.cpSync(path.join(root, 'server', 'db', 'migrations'), path.join(outdir, 'migrations'), {
  recursive: true,
});
console.log('Copied migrations to dist/server/migrations');
