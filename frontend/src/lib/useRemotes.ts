import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { BrokerStatus, KindDescriptor, MirrorDefaults, Registration, Remote, RemotesResponse } from './types';

// TEN SECONDS, and only while the tab is visible: each refresh costs one
// `docker inspect` or `ssh -O check` PER REMOTE, each bounded at 5 s. The manual
// refresh and the refresh after every action are unconditional.
export const POLL_MS = 10_000;

export interface RemotesState {
  remotes: Remote[];
  kinds: KindDescriptor[];
  /** Served by the backend from src/mirror.mjs; `null` until it arrives, and sticky after. */
  mirrorDefaults: MirrorDefaults | null;
  registration: Registration | null;
  /** The agent listener's state, asked for only while an agent remote exists; null otherwise. */
  broker: BrokerStatus | null;
  updatedAt: Date | null;
  loadError: string | null;
  /** Whether any refresh has succeeded yet. */
  loaded: boolean;
}

const INITIAL: RemotesState = {
  remotes: [], kinds: [], mirrorDefaults: null, registration: null, broker: null, updatedAt: null, loadError: null, loaded: false,
};

/**
 * The polled card data. The poll never looks at an open form: the form's draft is separate state,
 * so a refresh re-renders the cards underneath it and leaves the typed values alone.
 */
export function useRemotes() {
  const [state, setState] = useState<RemotesState>(INITIAL);
  // Refreshes overlap (a poll, a post-action refresh). Only the newest one started may land, so a
  // slow earlier answer can never put back a gate the operator just moved.
  const started = useRef(0);
  const landed = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++started.current;
    try {
      const [r, registration] = await Promise.all([
        api<RemotesResponse>('api/remotes'),
        api<Registration>('api/registration'),
      ]);
      // A page with no agent remote never asks: the listener does not run then, and saying so on
      // every docker-only page would be noise.
      const broker = r.remotes.some((x) => !x.broken && x.kind === 'agent')
        ? await api<BrokerStatus>('api/agent/broker').catch(() => null)
        : null;
      if (seq < landed.current) return;
      landed.current = seq;
      setState((s) => ({
        remotes: r.remotes,
        kinds: r.kinds,
        mirrorDefaults: r.mirrorDefaults ?? s.mirrorDefaults,
        registration,
        broker,
        updatedAt: new Date(),
        loadError: null,
        loaded: true,
      }));
    } catch (e) {
      if (seq < landed.current) return;
      landed.current = seq;
      setState((s) => ({ ...s, loadError: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { ...state, refresh };
}
