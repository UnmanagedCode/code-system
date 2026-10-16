// The backend's own kind descriptors (src/launcher/kinds/index.mjs), provided by vitest.config.ts, so
// the UI tests track the shipped `advanced`/`secret` flags.
import { inject } from 'vitest';
import type { KindDescriptor } from '@/lib/types';

declare module 'vitest' {
  export interface ProvidedContext {
    kindDescriptors: KindDescriptor[];
  }
}

export const kindDescriptors = (): KindDescriptor[] => inject('kindDescriptors');
