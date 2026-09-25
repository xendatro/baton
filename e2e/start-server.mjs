// Starts the production build for Playwright on a fresh DATA_DIR (wiped on every run).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), 'baton-e2e');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const server = spawn(process.execPath, ['--enable-source-maps', 'dist/server/index.js'], {
  env: { ...process.env, DATA_DIR: dataDir },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
