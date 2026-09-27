// Bundles the desktop app with esbuild: the main process and preload (CommonJS for Electron), plus
// the offline page and the icon. The window shows the Baton web app itself (BAT-26). `@shared/*`
// resolves to the repository's shared code, so the app and the server agree on contracts.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const alias = { '@shared': path.resolve(root, '..', 'shared') };
// Shared code's own imports (zod) resolve from the app's node_modules too, so a release build
// doesn't need the repository root installed.
const nodePaths = [path.join(root, 'node_modules')];
rmSync(out, { recursive: true, force: true });
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

// The offline page (when the Baton server can't be reached) and the window / tray icon.
copyFileSync(path.join(root, 'src', 'offline', 'offline.html'), path.join(out, 'offline.html'));
copyFileSync(path.join(root, 'build', 'icon.png'), path.join(out, 'icon.png'));
