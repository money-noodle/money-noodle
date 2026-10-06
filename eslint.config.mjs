import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// ADR-0013 draws the M4 engine boundary before any of it is built. Execution
// belongs to the `services/engine-jobs` family, each job under its own workload
// identity and schedule; a request-serving deployment never acquires a
// scheduler, a queue consumer or a timer, and the web reaches engine data only
// through the API contract. A flat config replaces a rule rather than merging
// it, so these groups are spread into every block that has to restate them.
const SCHEDULER_RUNTIME_MODULES = [
  'node-cron',
  'node-schedule',
  'cron',
  'bull',
  'bullmq',
  'agenda',
  'bree',
  '@google-cloud/scheduler',
  '@google-cloud/tasks',
  '@google-cloud/pubsub',
];

const ENGINE_JOBS_MODULES = ['@money-noodle/engine-jobs', '**/services/engine-jobs/**'];

const ENGINE_STORE_ADAPTER_MODULES = ['**/adapters/engine-store/**'];

const NO_RESIDENT_WORK_MESSAGE =
  'Execution belongs to the engine jobs family under its own workload identity and schedule. A request-serving deployment never acquires a scheduler, a queue consumer or a timer (ADR-0013).';

const NO_ENGINE_STORE_MESSAGE =
  'The engine store is reached through one read-only adapter in the platform API, and never from here (ADR-0013).';

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
            {
              name: 'postgres',
              message:
                'The database driver belongs in the projection adapter. Inner layers depend on the projection port (ADR-0012).',
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
            {
              // ADR-0012 admits a read-only projection port. The port is an
              // interface the inner layers own; the driver and the adapter that
              // uses it are outside, and stay outside.
              group: [
                'postgres',
                'postgres/**',
                'pg',
                'pg/**',
                'pg-*',
                'mysql',
                'mysql2',
                'sqlite3',
                'better-sqlite3',
                'mongodb',
                'ioredis',
                '**/adapters/projection/**',
              ],
              message:
                'Inner API layers depend on the projection port, never on a database driver or its adapter.',
            },
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
            },
            {
              group: [...ENGINE_STORE_ADAPTER_MODULES],
              message: NO_ENGINE_STORE_MESSAGE,
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
      // Each of these has its own trailing block, so the exemption it needs is
      // granted there rather than by removing every restriction here.
      'services/platform-api/src/adapters/telemetry/workload-identity-headers.ts',
      'services/platform-api/src/adapters/projection/**/*.ts',
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
            {
              name: 'postgres',
              message:
                'Only services/platform-api/src/adapters/projection may import a database driver (ADR-0012).',
            },
            {
              name: 'pg',
              message:
                'Only services/platform-api/src/adapters/projection may import a database driver (ADR-0012).',
            },
          ],
          patterns: [
            {
              group: ['google-auth-library/**', 'googleapis', '@google-cloud/**'],
              message:
                'The accepted exception covers workload authentication for OTLP export only, not a provider SDK.',
            },
            {
              group: [
                'postgres/**',
                'pg/**',
                'pg-*',
                'mysql',
                'mysql2',
                'sqlite3',
                'better-sqlite3',
                'mongodb',
                'ioredis',
              ],
              message:
                'The accepted exception is one PostgreSQL adapter for one read-only projection, not a database client anywhere in the service (ADR-0012).',
            },
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // ADR-0012 admits one read-only projection port with one PostgreSQL adapter.
  // This block is the exception the driver restriction above exists for, and it
  // is declared after that block because a flat config replaces a rule rather
  // than merging it: the last matching configuration is the one in force. The
  // provider-authentication restriction is restated here so permitting the driver
  // does not quietly permit a provider SDK as well.
  {
    files: ['services/platform-api/src/adapters/projection/**/*.ts'],
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
                'The projection adapter reads a database. It is not a provider SDK boundary.',
            },
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // The telemetry authentication adapter keeps its narrow provider-authentication
  // exception, and gains no database exception with it.
  {
    files: ['services/platform-api/src/adapters/telemetry/workload-identity-headers.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'postgres',
              message:
                'Only services/platform-api/src/adapters/projection may import a database driver (ADR-0012).',
            },
            {
              name: 'pg',
              message:
                'Only services/platform-api/src/adapters/projection may import a database driver (ADR-0012).',
            },
          ],
          patterns: [
            {
              group: [
                'postgres/**',
                'pg/**',
                'pg-*',
                'mysql',
                'mysql2',
                'sqlite3',
                'better-sqlite3',
                'mongodb',
                'ioredis',
              ],
              message:
                'The accepted exception is one PostgreSQL adapter for one read-only projection, not a database client anywhere in the service (ADR-0012).',
            },
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
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
            {
              // ADR-0012 admits a projection port in the API only. The web is a
              // presentation client and never becomes a direct database client,
              // which is an accepted rule in `overview.md` and older than this
              // projection. It is restated as a driver ban so the rule does not
              // depend on noticing that a module name happens to be a database.
              group: [
                'postgres',
                'postgres/**',
                'pg',
                'pg/**',
                'pg-*',
                'mysql',
                'mysql2',
                'sqlite3',
                'better-sqlite3',
                'mongodb',
                'ioredis',
                '**/adapters/projection/**',
                '**/domain/paper-projection*',
                '**/domain/projection-privileges*',
              ],
              message:
                'The web may never be a database client, directly or through an API projection module (overview.md, ADR-0012).',
            },
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
            },
            {
              group: [...ENGINE_STORE_ADAPTER_MODULES],
              message: NO_ENGINE_STORE_MESSAGE,
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
              group: [
                '@opentelemetry/**',
                '**/adapters/**',
                'google-auth-library',
                // This block is the last matching configuration for these files,
                // so it replaces the web-wide rule rather than adding to it. The
                // driver ban is restated here or presentation would be the one
                // place in the web that could import one (ADR-0012).
                'postgres',
                'postgres/**',
                'pg',
                'pg/**',
                'pg-*',
                'mysql',
                'mysql2',
                'sqlite3',
                'better-sqlite3',
                'mongodb',
                'ioredis',
                '**/domain/paper-projection*',
                '**/domain/projection-privileges*',
              ],
              message:
                'Presentation stays independent of telemetry, adapters, provider authentication and any database client.',
            },
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
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
            {
              group: [...SCHEDULER_RUNTIME_MODULES, ...ENGINE_JOBS_MODULES],
              message: NO_RESIDENT_WORK_MESSAGE,
            },
            {
              group: [...ENGINE_STORE_ADAPTER_MODULES],
              message: NO_ENGINE_STORE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
);
