// Bundles the desktop app with esbuild: the main process and preload (CommonJS for Electron) and
// the renderer (a browser script), plus the renderer's HTML and CSS. `@shared/*` resolves to the
// repository's shared code, so the app and the server agree on contracts and chain resolution.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const alias = { '@shared': path.resolve(root, '..', 'shared') };
// Shared code's own imports (zod) resolve from the app's node_modules too, so a release build
// doesn't need the repository root installed.
const nodePaths = [path.join(root, 'node_modules')];
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    main: path.join(root, 'src', 'main', 'main.ts'),
    preload: path.join(root, 'src', 'preload.ts'),
  },
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  alias,
  nodePaths,
  sourcemap: true,
});

await build({
  entryPoints: { renderer: path.join(root, 'src', 'renderer', 'renderer.ts') },
  outdir: out,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  alias,
  nodePaths,
  sourcemap: true,
});

for (const file of ['index.html', 'styles.css']) {
  copyFileSync(path.join(root, 'src', 'renderer', file), path.join(out, file));
}
