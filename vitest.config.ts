import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript source (see tsconfig.base.json customConditions).
const sourceConditions = ['@ehub/source', 'node', 'import', 'module', 'default'];

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
          name: 'security',
          environment: 'node',
          include: ['tests/security/**/*.test.ts'],
        },
      },
    ],
  },
});
