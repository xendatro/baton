import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { aliases } from './vite.config.ts';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'web',
          include: ['web/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['web/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts', 'web/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', 'server/test/**', 'web/test/**', 'web/components/ui/**'],
    },
  },
});
