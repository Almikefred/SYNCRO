import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export type { defineConfig };

export default defineConfig({
  root: resolve(__dirname),
  css: {
    postcss: {},
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
