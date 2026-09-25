import os from 'node:os';
import path from 'node:path';

/**
 * Where the e2e server runs and keeps its data. Shared by playwright.config.ts (which starts the
 * server) and the specs (which read the test mailbox and the database), so both sides agree.
 * E2E_PORT lets parallel checkouts run the suite side by side.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);

export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** A fresh directory per port, wiped by e2e/start-server.mjs on every run. */
export const E2E_DATA_DIR = path.join(os.tmpdir(), `baton-e2e-${E2E_PORT}`);
