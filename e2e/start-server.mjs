// Starts the production build for Playwright on a fresh DATA_DIR (wiped on every run).
// playwright.config.ts passes DATA_DIR (see e2e/support/env.ts); it must never be development data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = process.env.DATA_DIR;
if (!dataDir || !path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()))) {
  throw new Error(`e2e DATA_DIR must be a folder under ${os.tmpdir()}, got ${String(dataDir)}`);
}
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const server = spawn(process.execPath, ['--enable-source-maps', 'dist/server/index.js'], {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
