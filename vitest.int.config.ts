import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/int/**/*.test.ts'], setupFiles: ['test/setup.ts'], testTimeout: 30000, fileParallelism: false },
});
