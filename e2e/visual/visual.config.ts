import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Visual review of the shared UI: screenshots of the component gallery (`/__dev/components`,
 * development only) and the auth pages in light and dark, at desktop and phone widths. Runs
 * against the Vite dev server with the API mocked in the browser, so no backend is needed.
 *
 *   npx playwright test -c e2e/visual/visual.config.ts
 *
 * Screenshots land in test-results/visual/ for a person (or agent) to look at.
 */
const PORT = Number(process.env.VISUAL_PORT ?? 5174);

export default defineConfig({
  testDir: '.',
  testMatch: '*.visual.ts',
  outputDir: '../../test-results/visual-output',
  fullyParallel: true,
  reporter: 'list',
  // The dev server compiles modules on first request, so the first pages can be slow.
  expect: { timeout: 30_000 },
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: path.join(import.meta.dirname, '..', '..'),
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
