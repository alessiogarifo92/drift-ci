// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'test/fixtures/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The core is pure: I/O lives in adapters supplied by the CLI or the Action.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'child_process', 'node:child_process'].map(
            (name) => ({
              name,
              message: 'src/core must stay pure: read files and run git through an adapter.',
            }),
          ),
          patterns: [
            {
              group: ['@actions/*'],
              message: 'src/core must not depend on GitHub Actions: keep that in src/action.',
            },
          ],
        },
      ],
    },
  },
);
