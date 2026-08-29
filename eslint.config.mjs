import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      'packages/platform-api-client/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:package'],
            },
            {
              sourceTag: 'type:service',
              onlyDependOnLibsWithTags: ['type:package'],
            },
            {
              sourceTag: 'type:package',
              onlyDependOnLibsWithTags: ['type:package'],
            },
          ],
          enforceBuildableLibDependency: true,
        },
      ],
    },
  },
  {
    files: [
      'services/platform-api/src/domain/**/*.ts',
      'services/platform-api/src/application/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fastify', message: 'Fastify belongs in the HTTP adapter.' },
            { name: 'next', message: 'Next.js belongs in the web adapter.' },
            { name: 'react', message: 'React belongs in interface projects.' },
          ],
          patterns: [
            {
              group: ['fastify/**', 'next/**', 'react/**', '@opentelemetry/**'],
              message: 'Inner API layers must remain framework and telemetry-backend independent.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{js,jsx,ts,tsx}'],
    languageOptions: jsxA11y.configs.recommended.languageOptions,
    plugins: {
      '@next/next': nextPlugin,
      'jsx-a11y-x': jsxA11y,
      'react-hooks': reactHooks,
    },
    settings: {
      next: { rootDir: 'apps/web/' },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...jsxA11y.configs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      '@next/next/no-html-link-for-pages': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/platform-api/**', '@money-noodle/platform-api'],
              message: 'The web may use only the generated platform API client.',
            },
          ],
        },
      ],
    },
  },
);
