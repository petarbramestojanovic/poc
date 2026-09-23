// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores(['dist/**', 'coverage/**', 'supabase/.temp/**', 'dev/**']),

  { files: ['**/*.{js,ts}'], extends: [js.configs.recommended] },

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Type-only imports are enforced by the compiler (verbatimModuleSyntax), not by lint.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
    },
  },

  // Fastify plugins, hooks and handlers (and the fetch fakes and route handlers tests define)
  // are async by contract even when they never await. Everywhere else the rule stays on.
  {
    files: ['src/app.ts', 'src/routes/**/*.ts', 'src/plugins/**/*.ts', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // Operator CLI prints to stdout by design.
  { files: ['src/cli/**/*.ts'], rules: { 'no-console': 'off' } },

  prettier,
)
