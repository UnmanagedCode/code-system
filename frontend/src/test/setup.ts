import { afterEach, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { fetchOutsideApi } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  history.replaceState(null, '', '/');
  const outside = fetchOutsideApi.splice(0);
  expect(outside, 'fetch reached outside lib/api.ts').toEqual([]);
});
