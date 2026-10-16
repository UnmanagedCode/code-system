import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { COPY_RESET_MS } from '@/components/CredRow';
import { stripeClass } from '@/lib/cardState.mjs';
import { POLL_MS } from '@/lib/useRemotes';
import {
  REMOTES, addTile, card, cardEl, lastBody, renderApp, settle, stubFetch, type Call,
} from '@/test/fixtures';

const notices = () => screen.queryByRole('region', { name: 'Notices' });
const posts = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const gets = (calls: Call[], path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;

describe('shell', () => {
  // Invariant: the page names itself, says what it reaches, and shows the registration state once known.
  it('header: title, subtitle, and the registration pill', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Code System' })).toBeTruthy();
    expect(screen.getByText("Docker containers and SSH hosts, reached from code-conductor's own machine.")).toBeTruthy();
    expect(screen.getByText('registration: ok')).toBeTruthy();
  });

  // Invariant: before the first answer the page says it is loading and shows no card and no pill;
  // both GETs go out together, uncached.
  it('loading state until the first answer, with both GETs in parallel and uncached', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { calls } = stubFetch({ reply: async () => { await gate; return null; } });
    render(<App />);
    expect(screen.getByRole('status').textContent).toContain('Loading remotes…');
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.queryByText(/^registration:/)).toBeNull();
    await waitFor(() => expect(calls.map((c) => c.path).sort()).toEqual(['api/registration', 'api/remotes']));
    expect(calls.every((c) => c.cache === 'no-store')).toBe(true);
    release();
    await waitFor(() => expect(screen.queryByText('Loading remotes…')).toBeNull());
    expect(screen.getAllByRole('article')).toHaveLength(REMOTES.length);
  });

  // Invariant: a failed refresh says so with the cause and a retry; cards already shown stay.
  it('Backend unreachable: names the cause, keeps the cards, and Retry refetches', async () => {
    const user = userEvent.setup();
    const { calls, state } = await renderApp();
    state.reply = () => ({ status: 502, body: { error: 'boom' } });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await screen.findByText('Backend unreachable: boom');
    expect(screen.getAllByRole('article')).toHaveLength(REMOTES.length);
    state.reply = undefined;
    const before = gets(calls, 'api/remotes');
    await user.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Backend unreachable/)).toBeNull());
    expect(gets(calls, 'api/remotes')).toBe(before + 1);
  });

  // Invariant: an empty store says so rather than rendering nothing.
  it('an empty store says so', async () => {
    await renderApp({ remotes: [] });
    expect(screen.getByText('No remotes yet. Add a Docker container or an SSH host to get started.')).toBeTruthy();
  });

  // Invariant: Refresh refreshes unconditionally and stamps the time.
  it('Refresh re-reads both routes and stamps "updated"', async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp();
    expect(screen.getByText(/^updated /)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    expect(gets(calls, 'api/registration')).toBe(2);
  });
});

describe('cards', () => {
  // Invariant: one card per remote, the unreadable one included, in served order.
  it('every remote renders a card, in served order', async () => {
    await renderApp();
    const ids = screen.getAllByRole('article').map((a) => a.getAttribute('data-remote-id'));
    expect(ids).toEqual(REMOTES.map((r) => r.remoteId));
    expect(screen.getByRole('article', { name: 'Running app' })).toBe(cardEl('on-up'));
    expect(screen.getByRole('article', { name: 'future' })).toBe(cardEl('future'));
  });

  // Invariant: the gate word and the probe word are separate elements, and the disagreeing rows show it.
  it('each card shows the gate word and the probe word as separate facts', async () => {
    await renderApp();
    const words = (id: string) => [
      cardEl(id).querySelector('[data-slot="gate-word"]')?.textContent,
      cardEl(id).querySelector('[data-slot="probe-word"]')?.textContent,
    ];
    expect(words('on-up')).toEqual(['Enabled', 'running']);
    expect(words('on-down')).toEqual(['Enabled', 'container not running']);
    expect(words('off-up')).toEqual(['Disabled', 'running']);
    expect(words('ssh-down')).toEqual(['Enabled', 'shared connection down']);
  });

  // Invariant: only the gate-on, probe-down cards carry a warning, with what is actually lost.
  it('only the disagreeing cards carry a warning, and it says the right thing', async () => {
    await renderApp();
    const note = (id: string) => within(cardEl(id)).queryAllByRole('note').map((n) => n.textContent).join(' ');
    expect(note('on-down')).toMatch(/never starts one/);
    expect(note('ssh-down')).toMatch(/Commands still run/);
    expect(note('on-up')).toBe('');
    expect(note('off-up')).toBe('');
  });

  // Invariant: the gate note renders only for a kind with copy (ssh), never as an empty element.
  it('the gate note renders only for a kind with copy', async () => {
    await renderApp();
    expect(card('ssh-down').getByText(/the gate is what stops them, not the connection/i)).toBeTruthy();
    for (const id of ['on-up', 'on-down', 'off-up']) {
      expect([...cardEl(id).querySelectorAll('p')].filter((e) => e.textContent?.trim() === '')).toHaveLength(0);
      expect(cardEl(id).textContent).not.toMatch(/gate is what stops them/);
    }
  });

  // Invariant: the hand-off contract is on every working card — the id verbatim, and where it goes.
  it('every working card shows its remoteId and where it goes', async () => {
    await renderApp();
    for (const id of ['on-up', 'on-down', 'off-up', 'ssh-down']) {
      expect(cardEl(id).querySelector('[data-slot="cred-value"]')?.textContent).toBe(id);
      expect(card(id).getByText("Paste this into a code-conductor project's Remote field.")).toBeTruthy();
    }
  });

  // Invariant: the target's own words reach the card: the probe detail and each baseline line.
  it("the target's own words reach the card, not a paraphrase", async () => {
    await renderApp();
    expect(card('on-down').getByText("container 'stopped' exists but is not running")).toBeTruthy();
    expect(card('ssh-down').getByText("no master for 'me@box'")).toBeTruthy();
    expect(card('ssh-down').getByText('readDir — find -printf: find: unrecognized: -printf')).toBeTruthy();
  });

  // Invariant: a broken record shows the store's message, offers Delete only, and has no cred row.
  it("a broken card shows the store's message and only a Delete button", async () => {
    await renderApp();
    const c = card('future');
    expect(c.getByText(/stored at schema 9/)).toBeTruthy();
    expect(c.getByText('not readable')).toBeTruthy();
    expect(c.getAllByRole('button').map((b) => b.textContent)).toEqual(['Delete']);
    expect(cardEl('future').querySelector('[data-slot="cred-value"]')).toBeNull();
  });

  // Invariant: the action button moves the gate: Disconnect when on, Connect when off, whatever the probe.
  it('the action button matches the gate, not the probe', async () => {
    await renderApp();
    const buttons = (id: string) => card(id).getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Copy');
    expect(buttons('on-down')).toEqual(['Disconnect', 'Edit', 'Delete']);
    expect(buttons('off-up')).toEqual(['Connect', 'Edit', 'Delete']);
  });

  // Invariant: each working card's stripe is its id's class from the fixed set, stable across a refresh;
  // the broken card's is the destructive one, with no identity class.
  it('each card carries its id\'s stripe class, stable across a refresh', async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp();
    const stripes = () => screen.getAllByRole('article').map((a) => [...a.classList].filter((c) => /^stripe-/.test(c)));
    const first = stripes();
    REMOTES.forEach((r, i) => {
      expect(first[i]).toEqual(r.broken ? [] : [stripeClass(r.remoteId)]);
    });
    expect(cardEl('future').classList.contains('border-l-destructive')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    expect(stripes()).toEqual(first);
  });
});

describe('registration and notices', () => {
  // Invariant: a blocked registration shows cc's own words verbatim, with a Retry, and the pill says so.
  it('a blocked registration shows its rows verbatim, with a Retry that re-registers and re-reads', async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp({
      registration: {
        state: 'blocked', detail: 'cc refused the row',
        rows: [{ id: 'docker', state: 'blocked', message: "'/x' is a git repository. Move the store." }, { id: 'ssh', state: 'ok', message: 'ok' }],
      },
    });
    const region = within(notices()!);
    expect(region.getByText('System registration')).toBeTruthy();
    expect(region.getByText('cc refused the row').tagName).toBe('PRE');
    expect(region.getByText("docker: '/x' is a git repository. Move the store.").tagName).toBe('PRE');
    expect(region.queryByText(/^ssh:/)).toBeNull();
    expect(screen.getByText('registration: blocked')).toBeTruthy();
    await user.click(region.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    expect(posts(calls).map((c) => c.path)).toEqual(['api/registration/retry']);
  });

  // Invariant: a failed retry becomes an "Action failed" notice with the backend's words.
  it('a refused retry is an Action failed notice', async () => {
    const user = userEvent.setup();
    await renderApp({
      registration: { state: 'unreachable', rows: [{ id: 'ssh', state: 'unreachable', message: 'ECONNREFUSED' }] },
      reply: (path, method) => (method === 'POST' && path === 'api/registration/retry' ? { status: 500, body: { error: 'retry exploded' } } : null),
    });
    await user.click(within(notices()!).getByRole('button', { name: 'Retry' }));
    const region = within(await waitFor(() => notices()!));
    expect(await region.findByText('Action failed')).toBeTruthy();
    expect(region.getByText('retry exploded')).toBeTruthy();
  });

  // Invariant: a normal skip is a muted note, never an error, and its pill is neutral.
  it('a skipped registration is a muted note with cc\'s detail', async () => {
    await renderApp({ registration: { state: 'skipped', detail: 'CONDUCTOR_URL is not set', rows: [] } });
    const region = within(notices()!);
    expect(region.getByRole('status').textContent).toBe('CONDUCTOR_URL is not set');
    expect(region.queryByRole('alert')).toBeNull();
  });

  // Invariant: a notice is dismissible, and Dismiss removes it.
  it('Dismiss removes a notice', async () => {
    const user = userEvent.setup();
    await renderApp({ reply: (path, method) => (method === 'POST' && path.endsWith('/connect') ? { status: 502, body: { error: 'nope' } } : null) });
    await user.click(card('off-up').getByRole('button', { name: 'Connect' }));
    await within(await waitFor(() => notices()!)).findByText('nope');
    await user.click(within(notices()!).getByRole('button', { name: 'Dismiss' }));
    expect(notices()).toBeNull();
  });
});

describe('card actions', () => {
  // Invariant: Connect POSTs once to its own remote, disables the card while it runs, and re-reads
  // the list rather than flipping the gate optimistically.
  it('Connect POSTs to its own remote, is busy meanwhile, and re-reads the list', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { calls } = await renderApp({
      reply: async (path, method) => (method === 'POST' ? (await gate, { body: { remote: {} } }) : null),
    });
    await user.click(card('off-up').getByRole('button', { name: 'Connect' }));
    expect(cardEl('off-up').getAttribute('aria-busy')).toBe('true');
    for (const b of card('off-up').getAllByRole('button').filter((x) => x.textContent !== 'Copy')) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(cardEl('off-up').querySelector('[data-slot="gate-word"]')?.textContent).toBe('Disabled');
    release();
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    expect(posts(calls).map((c) => c.path)).toEqual(['api/remotes/off-up/connect']);
    await waitFor(() => expect(cardEl('off-up').getAttribute('aria-busy')).toBe('false'));
  });

  // Invariant: Disconnect's 200 `warning` reaches the operator as a Warning notice.
  it('a disconnect warning is surfaced, not swallowed', async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp({
      reply: (path, method) => (method === 'POST' && path.endsWith('/disconnect')
        ? { body: { remote: {}, warning: 'ssh could not close the master for me@box' } } : null),
    });
    await user.click(card('on-up').getByRole('button', { name: 'Disconnect' }));
    const region = within(await waitFor(() => notices()!));
    expect(await region.findByText('Warning')).toBeTruthy();
    expect(region.getByText('ssh could not close the master for me@box')).toBeTruthy();
    expect(posts(calls).map((c) => c.path)).toEqual(['api/remotes/on-up/disconnect']);
  });

  // Invariant: a refused connect (502 {error}) shows the transport's own words, and still re-reads.
  it("a refused connect shows the transport's own words", async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp({
      reply: (path, method) => (method === 'POST' && path.endsWith('/connect')
        ? { status: 502, body: { error: 'Permission denied (publickey).' } } : null),
    });
    await user.click(card('off-up').getByRole('button', { name: 'Connect' }));
    const region = within(await waitFor(() => notices()!));
    expect(await region.findByText('Permission denied (publickey).')).toBeTruthy();
    expect(region.getByText('Action failed')).toBeTruthy();
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
  });

  // Invariant: Delete asks first; Cancel and Escape send nothing; confirming sends one DELETE, surfaces
  // the projects-still-naming-it warning, and re-reads. Focus returns to the opener.
  it('delete asks first, and only a confirm deletes', async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp({
      reply: (path, method) => (method === 'DELETE'
        ? { body: { deleted: 'on-up', warning: "1 cc project(s) still name remote 'on-up': web" } } : null),
    });
    const opener = card('on-up').getByRole('button', { name: 'Delete' });
    await user.click(opener);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("Delete remote 'on-up'?")).toBeTruthy();
    expect(within(dialog).getByText('This cannot be undone.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(calls)).toEqual([]);

    await user.click(opener);
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    expect(posts(calls).map((c) => [c.method, c.path])).toEqual([['DELETE', 'api/remotes/on-up']]);
    expect(within(notices()!).getByText("1 cc project(s) still name remote 'on-up': web")).toBeTruthy();
  });

  // Invariant: the broken card's Delete goes through the same confirm.
  it('a broken card deletes through the same confirm', async () => {
    const user = userEvent.setup();
    const { calls } = await renderApp();
    await user.click(card('future').getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts(calls).map((c) => [c.method, c.path])).toEqual([['DELETE', 'api/remotes/future']]));
  });
});

describe('copy', () => {
  // The cred row's button, whatever it currently reads.
  const copyButton = () => cardEl('on-up').querySelector('[data-slot="cred-value"]')!.parentElement!.querySelector('button')!;

  // Invariant: with no clipboard in this context, Copy never claims success; it says what to do instead,
  // linked from the button, and the id stays on screen.
  it('Copy reports failure when the clipboard is unavailable', async () => {
    await renderApp();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    fireEvent.click(copyButton());
    await settle();
    expect(copyButton().textContent).toBe('Select & copy');
    const note = document.getElementById(copyButton().getAttribute('aria-describedby')!);
    expect(note?.textContent).toBe('The browser would not give this page the clipboard — select the id and copy it by hand.');
    expect(cardEl('on-up').querySelector('[data-slot="cred-value"]')?.textContent).toBe('on-up');
  });

  // Invariant: a clipboard that rejects (a denied permission) is a failure too.
  it('Copy reports failure when the clipboard rejects', async () => {
    await renderApp();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('NotAllowedError'); } }, configurable: true });
    fireEvent.click(copyButton());
    await settle();
    expect(copyButton().textContent).toBe('Select & copy');
  });

  // Invariant: "Copied" only after the write resolves, with the id verbatim, and back to "Copy" after COPY_RESET_MS.
  it('Copy confirms only after the write resolves, then reverts', async () => {
    await renderApp();
    let resolve!: () => void;
    const writeText = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(copyButton());
    expect(writeText).toHaveBeenCalledWith('on-up');
    await act(async () => {});
    expect(copyButton().textContent).toBe('Copy');
    await act(async () => { resolve(); });
    expect(copyButton().textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(COPY_RESET_MS - 1); });
    expect(copyButton().textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(1); });
    expect(copyButton().textContent).toBe('Copy');
  });
});

describe('routing', () => {
  // Invariant: the route is written with replaceState into the query string only — never pushState,
  // never the hash.
  it('route writes: ?add, ?edit=<id>, and back to the list, by replaceState', async () => {
    const user = userEvent.setup();
    await renderApp();
    const replace = vi.spyOn(history, 'replaceState');
    const push = vi.spyOn(history, 'pushState');
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(location.search).toBe('?add');
    await user.click(card('on-up').getByRole('button', { name: 'Edit' }));
    expect(location.search).toBe('?edit=on-up');
    await user.click(card('on-up').getByRole('button', { name: 'Cancel' }));
    expect(location.search).toBe('');
    expect(replace.mock.calls.map((c) => c[2])).toEqual(['/?add', '/?edit=on-up', '/']);
    expect(push).not.toHaveBeenCalled();
    expect(location.hash).toBe('');
  });

  // Invariant: a popstate (cc's navigate) reads the route and drops the open form.
  it('popstate clears the draft', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(card('on-up').getByRole('button', { name: 'Edit' }));
    expect(card('on-up').queryByRole('textbox', { name: 'Label' })).toBeTruthy();
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(card('on-up').queryByRole('textbox', { name: 'Label' })).toBeNull();
  });

  // Invariant: deep links are declined — a loaded ?add or ?edit= shows the list, opens no form, and
  // leaves the URL as it was.
  it('a loaded ?add or ?edit= opens no form (deep links declined)', async () => {
    for (const search of ['?add', '?edit=on-up']) {
      history.replaceState(null, '', `/${search}`);
      const replace = vi.spyOn(history, 'replaceState');
      const { unmount } = await renderApp();
      expect(screen.queryByRole('region', { name: 'New remote' })).toBeNull();
      expect(document.querySelector('form')).toBeNull();
      expect(location.search).toBe(search);
      expect(replace).not.toHaveBeenCalled();
      replace.mockRestore();
      unmount();
    }
  });
});

describe('the poll', () => {
  // Invariant: every POLL_MS the list is re-read while the tab is visible, and not while it is hidden.
  it('polls every POLL_MS while visible, and not while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { calls } = await renderApp();
    expect(gets(calls, 'api/remotes')).toBe(1);
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
    await settle();
    expect(gets(calls, 'api/remotes')).toBe(2);
    vis.mockRestore();
  });

  // Invariant (Δ3): the poll re-renders cards under an open form, and the draft survives it.
  it('a poll under an open form updates other cards and keeps the draft', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const user = userEvent.setup();
    const { state, calls } = await renderApp();
    await user.click(card('off-up').getByRole('button', { name: 'Edit' }));
    const label = card('off-up').getByRole('textbox', { name: 'Label' }) as HTMLInputElement;
    await user.clear(label);
    await user.type(label, 'typed by hand');
    state.remotes = REMOTES.map((r) => (r.remoteId === 'on-down'
      ? { ...r, reachability: { connected: true, detail: "container 'stopped' running (img) since U" } } : r));
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    await waitFor(() => expect(cardEl('on-down').querySelector('[data-slot="probe-word"]')?.textContent).toBe('running'));
    expect((card('off-up').getByRole('textbox', { name: 'Label' }) as HTMLInputElement).value).toBe('typed by hand');
  });

  // Invariant: overlapping refreshes land newest-first only — a slow earlier answer never replaces a later one.
  it('a slow earlier refresh never overwrites a newer one', async () => {
    const user = userEvent.setup();
    const { state } = await renderApp();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const stale = REMOTES.map((r) => (r.remoteId === 'off-up' ? { ...r, label: 'stale label' } : r));
    let first = true;
    state.reply = async (path, method) => {
      if (method !== 'GET' || path !== 'api/remotes' || !first) return null;
      first = false;
      await held;
      return { body: { remotes: stale, kinds: state.kinds, mirrorDefaults: state.mirrorDefaults } };
    };
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    state.remotes = REMOTES.map((r) => (r.remoteId === 'off-up' ? { ...r, label: 'fresh label' } : r));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('article', { name: 'fresh label' })).toBeTruthy());
    release();
    await settle();
    expect(screen.queryByRole('article', { name: 'stale label' })).toBeNull();
    expect(screen.getByRole('article', { name: 'fresh label' })).toBeTruthy();
  });

  // Invariant: mirrorDefaults are replaced only by a response that carries them.
  it('mirrorDefaults stay once served, even when a later response omits them', async () => {
    const user = userEvent.setup();
    const { state, calls } = await renderApp();
    state.mirrorDefaults = null;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(gets(calls, 'api/remotes')).toBe(2));
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect((within(addTile()).getByRole('textbox', { name: 'Mirror root' }) as HTMLInputElement).value).toBe('/');
  });
});

describe('focus and keyboard', () => {
  // Invariant: Add focuses the remote id field; Edit focuses the card's Label field.
  it('Add focuses #f-id and Edit focuses #f-label', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(document.activeElement?.id).toBe('f-id');
    await user.click(card('on-up').getByRole('button', { name: 'Edit' }));
    expect(document.activeElement?.id).toBe('f-label');
    expect(cardEl('on-up').contains(document.activeElement)).toBe(true);
  });

  // Invariant: the keyboard order runs Add → Refresh → the first card's Copy.
  it('Tab from Add reaches Refresh, then the first card\'s Copy', async () => {
    const user = userEvent.setup();
    await renderApp();
    screen.getByRole('button', { name: 'Add remote' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }));
    await user.tab();
    expect(document.activeElement).toBe(card('on-up').getByRole('button', { name: 'Copy' }));
  });
});
