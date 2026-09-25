import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_DATA_DIR, E2E_PORT } from './e2e/support/env.ts';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Builds, then serves the app on a fresh temp DATA_DIR (never development data).
    command: 'npm run build && node e2e/start-server.mjs',
    url: `${E2E_BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(E2E_PORT),
      HOST: '127.0.0.1',
      BASE_URL: E2E_BASE_URL,
      DATA_DIR: E2E_DATA_DIR,
      BETTER_AUTH_SECRET: 'e2e-secret-that-is-at-least-32-characters-long',
      LOG_LEVEL: 'warn',
      // Emails land in DATA_DIR/mailbox/ for the specs to read. Empty values count as unset and
      // keep a developer's .env (SMTP, OAuth apps) out of the run.
      E2E_MAILBOX: 'true',
      SMTP_URL: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      SIGNUPS_ENABLED: 'true',
      // Each test sends its own CF-Connecting-IP (e2e/support/fixtures.ts), so the per-IP auth
      // rate limits apply per test instead of throttling the whole suite, which shares one socket
      // address.
      TRUST_PROXY: 'cloudflare',
    },
  },
});
