import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, json } from './api';
import { assertNoFetchOutsideApi, fetchOutsideApi, stubFetch } from '@/test/fixtures';

describe('api', () => {
  // Invariant: requests are relative only — a `/`-led path would reach cc's API — and never cached.
  it('refuses a root-relative path and sends every request uncached', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/remotes')).rejects.toThrow(/root-relative/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await api('api/remotes', json('POST', { a: 1 }))).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('api/remotes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}', cache: 'no-store',
    });
  });

  // Invariant: a failure carries the status and the backend's {error, code}, never the raw body.
  it('a failure carries status, message and code; a non-JSON body is "HTTP <status>"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no remote \'x\'","code":"NOPE"}', { status: 404 })));
    const e = await api('api/remotes/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 404, code: 'NOPE', message: "no remote 'x'" });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>secret</html>', { status: 502 })));
    expect(await api('api/remotes').catch((x) => x)).toMatchObject({ status: 502, code: undefined, message: 'HTTP 502' });
  });

  // Invariant: json() sends a body only when given one.
  it('json() builds the init', () => {
    expect(json('DELETE')).toEqual({ method: 'DELETE' });
    expect(json('PATCH', { label: 'x' })).toEqual({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"label":"x"}' });
  });
});

describe('the UI suites\' fetch stub', () => {
  // Invariant: the runtime half of "all network access goes through lib/api.ts": the stub every UI
  // suite installs refuses, and records, a fetch whose caller is not api.ts — however it was spelled —
  // while a call through api() passes.
  it('refuses a fetch that bypasses api(), and passes one that goes through it', async () => {
    stubFetch();
    const bypass = (globalThis as Record<string, unknown>)[['fet', 'ch'].join('')] as typeof fetch;
    await expect(bypass('api/remotes')).rejects.toThrow(/outside lib\/api\.ts/);
    expect(fetchOutsideApi.splice(0)).toEqual(['api/remotes']);
    expect(await api<{ remotes: unknown[] }>('api/remotes')).toHaveProperty('remotes');
    expect(fetchOutsideApi).toEqual([]);
  });
});

describe('the backstop setup.ts runs after every test', () => {
  // Invariant: a bypass the code under test swallowed still fails the test — the backstop throws on
  // any recorded bypass (naming it), drains the record, and passes when there is none. That setup.ts
  // calls it in afterEach is pinned in tests/frontend.test.mjs.
  it('throws on a recorded bypass, drains it, and passes on none', () => {
    expect(() => assertNoFetchOutsideApi()).not.toThrow();
    fetchOutsideApi.push('api/registration');
    expect(() => assertNoFetchOutsideApi()).toThrow(/outside lib\/api\.ts: api\/registration/);
    expect(fetchOutsideApi).toEqual([]);
    expect(() => assertNoFetchOutsideApi()).not.toThrow();
  });
});
