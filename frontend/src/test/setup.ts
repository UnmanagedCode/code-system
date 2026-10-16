import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { assertNoFetchOutsideApi } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  history.replaceState(null, '', '/');
  assertNoFetchOutsideApi();
});
