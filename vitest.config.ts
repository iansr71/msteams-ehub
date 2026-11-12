import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript source (see tsconfig.base.json customConditions).
// No `module` condition: with it Vite picks @opentelemetry/api's ESM build, whose extensionless
// imports Node cannot load. Node itself never uses that condition, so tests now resolve as
// production does.
const sourceConditions = ['@ehub/source', 'node', 'import', 'default'];

const shared = {
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions, externalConditions: ['@ehub/source'] } },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'acceptance',
          environment: 'node',
          include: ['tests/acceptance/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['tests/scripts/**/*.test.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'security',
          environment: 'node',
          include: ['tests/security/**/*.test.ts'],
        },
      },
    ],
  },
});
