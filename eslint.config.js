import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'dist/',
    'coverage/',
    'playwright-report/',
    'test-results/',
    'server/db/migrations/',
    // Agent worktrees (full checkouts) while parallel work is in progress.
    '.claude/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['server/**/*.ts', 'scripts/**', '*.config.{ts,js}', 'e2e/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // CLIs and the pre-logger bootstrap talk to the terminal directly.
    files: ['scripts/**', 'server/db/migrate-cli.ts', 'server/index.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['web/**/*.{ts,tsx,js}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
  {
    // shadcn/ui primitives export variants next to components.
    files: ['web/components/ui/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  prettier,
]);
