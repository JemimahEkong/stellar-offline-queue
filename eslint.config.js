// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.md'],
  },

  // Base rules for everything (including this config file).
  eslint.configs.recommended,

  // Tooling/config JS files are not part of any tsconfig project: parse them
  // without type information and disable rules that require it.
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Type-checked rules for all first-party TypeScript.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts', 'vitest.config.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      // Library source: no stray logging; errors must be typed, not printed.
      'no-console': 'error',
      // Explicit about the rules that protect the invariants this library exists for.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'examples/**/*.ts'],
    rules: {
      // Tests and examples may use console for output and looser typing where
      // the test framework requires it.
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  prettierConfig,
);
