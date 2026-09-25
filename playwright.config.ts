import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Builds, then serves the app on a fresh temp DATA_DIR (never development data).
    command: 'npm run build && node e2e/start-server.mjs',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      BASE_URL,
      BETTER_AUTH_SECRET: 'e2e-secret-that-is-at-least-32-characters-long',
      LOG_LEVEL: 'warn',
    },
  },
});
