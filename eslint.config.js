import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          // Root-level tool configs are not part of any package tsconfig.
          allowDefaultProject: [
            '*.js',
            '*.mjs',
            '*.ts',
            'scripts/*.mjs',
            'infrastructure/scripts/*.d.mts',
            'infrastructure/scripts/lib/*.d.mts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // CLI entry points and scripts write their result to the terminal by design.
    files: ['**/src/cli.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain JavaScript cannot carry type annotations; exported helpers have .d.mts files instead.
    files: ['**/*.js', '**/*.mjs'],
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },
  {
    // The administration page runs in the browser, with MSAL loaded as a global script.
    files: ['apps/api/admin-ui/**/*.js'],
    languageOptions: { globals: { ...globals.browser, msal: 'readonly' } },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
