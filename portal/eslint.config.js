// @ts-check
/**
 * Portal lint rules.
 *
 * Two rules here are architectural, not stylistic, and both are load-bearing:
 *
 *  - `no-restricted-imports` forbids reaching into the bot repo from anywhere
 *    under `portal/`. The Portal is a pure HTTP consumer of the Platform API
 *    (plan §1, success criterion §24.4); an import of `src/modules` would make
 *    that claim false silently.
 *  - `no-restricted-syntax` forbids raw `<img src>` inside `features/`. All
 *    artwork goes through the image resolver (plan §12, §24.13) so the asset
 *    source stays swappable.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          // shadcn/ui primitives export their `cva` variant map alongside the
          // component; that is the upstream pattern and is safe for HMR.
          allowExportNames: ['buttonVariants', 'badgeVariants'],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/../src/**', '../../src/*', '../../../src/*'],
              message:
                'The Portal is a pure Platform API consumer — never import bot source (plan §1, §24.4).',
            },
          ],
        },
      ],
    },
  },
  {
    // Test helpers deliberately export both components and utilities.
    files: ['src/test/**', '**/__tests__/**', 'msw/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Artwork must resolve through the image layer, never a literal path.
    files: ['src/features/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name="img"]',
          message:
            'Use <Artwork> — feature code never references an image path directly (plan §12, §24.13).',
        },
      ],
    },
  },
);
