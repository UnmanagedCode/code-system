import { defineConfig, mergeConfig } from 'vitest/config';
import { kindDescriptors } from '../src/launcher/kinds/index.mjs';
import viteConfig from './vite.config.ts';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // The backend's own kind descriptors, read here in Node: under the test
    // environment's web transform the backend module itself does not load.
    provide: { kindDescriptors: kindDescriptors() },
  },
}));
