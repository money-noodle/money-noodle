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
            {
              name: '@opentelemetry/api',
              message: 'Telemetry belongs in the telemetry adapter, not in inner layers.',
            },
            {
              name: 'google-auth-library',
              message:
                'The accepted authentication exception is narrow: only the telemetry authentication adapter may import it.',
            },
          ],
          patterns: [
            {
              group: [
                'fastify/**',
                'next/**',
                'react/**',
                '@opentelemetry/**',
                'google-auth-library',
                'google-auth-library/**',
                '**/adapters/telemetry/**',
              ],
              message:
                'Inner API layers must remain framework, telemetry-backend and provider-authentication independent.',
            },
          ],
        },
      ],
    },
  },
  // The 2026-09-15 accepted amendment to Working ADR-0007 permits an
  // exact-version Google authentication library in isolated server-side
  // telemetry authentication adapters, and nowhere else. Signal instrumentation
  // and serialization stay OpenTelemetry with replaceable exporters.
  {
    files: ['services/platform-api/src/**/*.ts'],
    ignores: [
      // The adapter the exception is for.
      'services/platform-api/src/adapters/telemetry/workload-identity-headers.ts',
      // Inner API layers keep their own, stricter rule above; listing them here
      // stops this block from replacing it, because the last matching config
      // wins for a given rule.
      'services/platform-api/src/domain/**/*.ts',
      'services/platform-api/src/application/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'google-auth-library',
              message:
                'Only the telemetry authentication adapter may import a provider authentication library (ADR-0007, 2026-09-15 amendment).',
            },
          ],
          patterns: [
            {
              group: ['google-auth-library/**', 'googleapis', '@google-cloud/**'],
              message:
                'The accepted exception covers workload authentication for OTLP export only, not a provider SDK.',
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
          paths: [
            {
              name: 'google-auth-library',
              message:
                'Only the telemetry authentication adapter may import a provider authentication library (ADR-0007, 2026-09-15 amendment).',
            },
          ],
          patterns: [
            {
              group: ['**/services/platform-api/**', '@money-noodle/platform-api'],
              message: 'The web may use only the generated platform API client.',
            },
            {
              group: ['google-auth-library/**', 'googleapis', '@google-cloud/**'],
              message:
                'The accepted exception covers workload authentication for OTLP export only, not a provider SDK.',
            },
          ],
        },
      ],
    },
  },
  // Presentation maps DTOs. It never reaches telemetry, and telemetry never
  // reaches a browser bundle through it. Declared after the block above so it
  // is the last matching configuration for these files.
  {
    files: ['apps/web/src/presentation/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opentelemetry/**', '**/adapters/**', 'google-auth-library'],
              message:
                'Presentation stays independent of telemetry, adapters and provider authentication.',
            },
          ],
        },
      ],
    },
  },
  // The one web file the accepted exception is for. Declared last so it is not
  // shadowed; it still may not reach the API service directly.
  {
    files: ['apps/web/src/adapters/telemetry/workload-identity-headers.ts'],
    rules: {
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
