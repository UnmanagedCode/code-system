// The UI tests' backend: one remote per row of the gate × probe table, the shipped ssh descriptor,
// and a fetch stub that records every request and answers from these fixtures.
import { expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '@/App';
import type { KindDescriptor, Registration, Remote, WorkingRemote } from '@/lib/types';
import { kindDescriptors } from './backend';

export const REAL_SSH = kindDescriptors().find((k) => k.kind === 'ssh')!;

export const DOCKER: KindDescriptor = {
  kind: 'docker',
  label: 'Docker containers',
  // Served as a boolean on every descriptor: a new docker remote starts ticked.
  mirrorByDefault: true,
  configFields: [
    { name: 'container', label: 'Container', required: true, placeholder: 'my-app', hint: 'the container' },
    // `advanced: true` routes this one into the Advanced group, not the connection block.
    { name: 'user', label: 'Run as', required: false, advanced: true, placeholder: 'node', hint: 'the identity' },
  ],
};

export const KINDS: KindDescriptor[] = [DOCKER, REAL_SSH];

export const MIRROR_DEFAULTS = { root: '/', exclude: ['/proc', '/dev', '/sys'] };
export const STORED_MIRROR = { root: '/srv/app', exclude: ['/proc', '/srv/app/tmp'] };

const okBaseline = { state: 'ok', missing: [] };
export const unknownBaseline = { state: 'unknown', missing: [] };

export const SSH_PLAIN: WorkingRemote = {
  remoteId: 'ssh-plain', kind: 'ssh', label: 'Plain', enabled: false,
  config: { host: 'h' }, mirror: null, baseline: unknownBaseline,
  reachability: { connected: false, detail: 'no master' },
};

export const REMOTES: Remote[] = [
  { // gate on, probe up
    remoteId: 'on-up', kind: 'docker', label: 'Running app', enabled: true,
    config: { container: 'app' }, mirror: null, baseline: okBaseline,
    reachability: { connected: true, detail: "container 'app' running (img) since T" },
  },
  { // gate on, probe DOWN — the docker warn row
    remoteId: 'on-down', kind: 'docker', label: 'Stopped app', enabled: true,
    config: { container: 'stopped' }, mirror: null, baseline: okBaseline,
    reachability: { connected: false, detail: "container 'stopped' exists but is not running" },
  },
  { // gate off, probe up — no alert. Its stored `config.user` gives the edit path an advanced value.
    remoteId: 'off-up', kind: 'docker', label: 'Disabled app', enabled: false,
    config: { container: 'app2', user: 'node' }, mirror: null, baseline: unknownBaseline,
    reachability: { connected: true, detail: "container 'app2' running (img) since T" },
  },
  { // gate on, master DOWN — the ssh warn row
    remoteId: 'ssh-down', kind: 'ssh', label: 'Box', enabled: true,
    config: { host: 'box', user: 'me' }, mirror: STORED_MIRROR,
    baseline: {
      state: 'unsupported',
      missing: [{ capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' }],
    },
    reachability: { connected: false, detail: "no master for 'me@box'" },
  },
  { // a record the store could not read
    remoteId: 'future',
    broken: { reason: 'schema', message: "remote 'future' is stored at schema 9, but this version reads schema 1 only — start the code-system backend" },
  },
];

export const REGISTRATION: Registration = { state: 'ok', rows: [{ id: 'docker', state: 'ok', message: 'ok' }], checkedAt: 'x' };

export const pwRemote = (storedSecrets: string[]): WorkingRemote => ({
  remoteId: 'pw-box', kind: 'ssh', label: 'Pw box', enabled: false,
  config: { host: '10.0.0.5', user: 'dev' }, storedSecrets, mirror: null, baseline: unknownBaseline,
  reachability: { connected: false, detail: 'no master' },
});

export interface Call { path: string; method: string; body: unknown; cache?: RequestCache }
type Scripted = { status?: number; body?: unknown } | null | undefined;
export type Reply = (path: string, method: string, body: unknown) => Scripted | Promise<Scripted>;

export interface Backend {
  remotes?: Remote[];
  registration?: Registration;
  /** `null` serves no `mirrorDefaults` key: the "not served yet" state. */
  mirrorDefaults?: typeof MIRROR_DEFAULTS | null;
  kinds?: KindDescriptor[];
  /** Scripts any request's answer; return nothing to fall through to the fixtures. */
  reply?: Reply;
}

/** Installs a recording fetch. `state` is live: a test may change what later GETs answer. */
export function stubFetch(opts: Backend = {}) {
  const state = {
    remotes: REMOTES, registration: REGISTRATION, mirrorDefaults: MIRROR_DEFAULTS as typeof MIRROR_DEFAULTS | null,
    kinds: KINDS, ...opts,
  };
  const calls: Call[] = [];
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path, method, body, cache: init.cache });
    const scripted = await state.reply?.(path, method, body);
    if (scripted) return respond(scripted.status ?? 200, scripted.body ?? {});
    if (path === 'api/remotes' && method === 'GET') {
      return respond(200, { remotes: state.remotes, kinds: state.kinds, ...(state.mirrorDefaults ? { mirrorDefaults: state.mirrorDefaults } : {}) });
    }
    if (path === 'api/registration' && method === 'GET') return respond(200, state.registration);
    return respond(200, {});
  }));
  return { calls, state };
}

/** Renders the App over a stubbed backend and waits for the first answer to land. */
export async function renderApp(opts: Backend = {}) {
  const backend = stubFetch(opts);
  const utils = render(createElement(App));
  await waitFor(() => expect(screen.queryByText('Loading remotes…')).toBeNull());
  return { ...utils, ...backend };
}

/** A remote's card, found by its `data-remote-id`. */
export function cardEl(id: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[data-remote-id]')].find((e) => e.getAttribute('data-remote-id') === id);
  if (!el) throw new Error(`no card for ${id}`);
  return el;
}
export const card = (id: string) => within(cardEl(id));

/** The add tile, once open. */
export const addTile = () => screen.getByRole('region', { name: 'New remote' });

/** Every form control's id under `root`, in document order (Radix checkboxes are buttons). */
export const controlIds = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('input:not([aria-hidden="true"]), select, textarea, button[role="checkbox"]')]
  .map((e) => e.id).filter(Boolean);

/** Everything rendered under `root` except tooltip bodies: what shows without a hover, focus or tap. */
export function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const t of clone.querySelectorAll('[role="tooltip"]')) t.remove();
  return clone.textContent ?? '';
}

/** Lets pending promise callbacks and the React updates they cause run. */
export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

export const lastBody = (calls: Call[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).at(-1)?.body as Record<string, unknown> | undefined;
