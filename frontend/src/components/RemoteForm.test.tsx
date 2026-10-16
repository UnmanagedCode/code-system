import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  DOCKER, KINDS, MIRROR_DEFAULTS, REAL_SSH, REMOTES, SSH_PLAIN, STORED_MIRROR, addTile, card, cardEl, controlIds,
  lastBody, pwRemote, renderApp, visibleText, type Backend,
} from '@/test/fixtures';
import type { WorkingRemote } from '@/lib/types';

const SSH_FIRST = [REAL_SSH, DOCKER];
const byId = <T extends HTMLElement = HTMLInputElement>(root: HTMLElement, id: string) => root.querySelector<T>(`#${id}`);
const detailsOf = (root: HTMLElement) => root.querySelector('details')!;
const summaryState = (root: HTMLElement) => detailsOf(root).querySelector('summary [data-slot="summary-state"]')!.textContent;
const summaryTitle = (root: HTMLElement) => [...detailsOf(root).querySelector('summary')!.childNodes]
  .filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('');
const checked = (root: HTMLElement, id: string) => byId(root, id)!.getAttribute('aria-checked') === 'true';

async function openAdd(opts: Backend = {}) {
  const user = userEvent.setup();
  const app = await renderApp(opts);
  await user.click(screen.getByRole('button', { name: 'Add remote' }));
  return { user, ...app, tile: addTile() };
}

async function openEdit(id: string, opts: Backend = {}) {
  const user = userEvent.setup();
  const app = await renderApp(opts);
  await user.click(card(id).getByRole('button', { name: 'Edit' }));
  return { user, ...app, form: cardEl(id).querySelector('form')! };
}

const submit = (user: ReturnType<typeof userEvent.setup>, root: HTMLElement, name: 'Create' | 'Save') =>
  user.click(within(root).getByRole('button', { name }));

describe('the add form', () => {
  // Invariant: one control per descriptor field, per kind, in the form's order: id, kind, label, the
  // connection fields, then the Advanced group (advanced config fields first, then the mirror form).
  it('renders one control per descriptor field, per kind, in order', async () => {
    const { user, tile } = await openAdd();
    expect(within(tile).getByRole('heading', { name: 'New remote' })).toBeTruthy();
    expect(controlIds(tile)).toEqual(['f-id', 'f-kind', 'f-label', 'f-container', 'f-user', 'f-mirror-on', 'f-mirror-root', 'f-mirror-exclude']);
    await user.selectOptions(byId<HTMLSelectElement>(tile, 'f-kind')!, 'ssh');
    expect(controlIds(addTile())).toEqual(['f-id', 'f-kind', 'f-label', 'f-host', 'f-user', 'f-port', 'f-password', 'f-identityFile', 'f-mirror-on', 'f-mirror-root', 'f-mirror-exclude']);
    expect(within(addTile()).getByText('User (optional)')).toBeTruthy();
    expect(within(addTile()).getByText('Host')).toBeTruthy();
    expect([...byId<HTMLSelectElement>(addTile(), 'f-kind')!.options].map((o) => o.textContent)).toEqual(KINDS.map((k) => k.label));
  });

  // Invariant: a new docker remote starts with Advanced collapsed, the mirror ticked, and the fields
  // prefilled from the SERVED defaults; the summary states the mirror.
  it('docker: Advanced collapsed, ticked, prefilled from the served defaults', async () => {
    const { tile } = await openAdd();
    expect(detailsOf(tile).open).toBe(false);
    expect(summaryTitle(tile)).toBe('Advanced');
    expect(summaryState(tile)).toBe(' · mirror /');
    expect(checked(tile, 'f-mirror-on')).toBe(true);
    expect(byId(tile, 'f-mirror-root')!.value).toBe(MIRROR_DEFAULTS.root);
    expect(byId<HTMLTextAreaElement>(tile, 'f-mirror-exclude')!.value).toBe(MIRROR_DEFAULTS.exclude.join('\n'));
    expect(byId(tile, 'f-mirror-root')!.disabled).toBe(false);
  });

  // Invariant: the Add draft is the FIRST SERVED kind's, not a hardcoded docker.
  it('drafts the first served kind: ssh-first opens ssh, ticked and collapsed', async () => {
    const { tile } = await openAdd({ remotes: [], kinds: SSH_FIRST });
    expect(byId(tile, 'f-host')).toBeTruthy();
    expect(checked(tile, 'f-mirror-on')).toBe(true);
    expect(detailsOf(tile).open).toBe(false);
  });

  // Invariant: ssh's Port, Password and Key file sit inside Advanced; only the connection fields outside.
  it('ssh keeps Port, Password and Key file inside the collapsed Advanced group', async () => {
    const { tile } = await openAdd({ remotes: [], kinds: SSH_FIRST });
    const inside = new Set(controlIds(detailsOf(tile)));
    expect(controlIds(tile).filter((id) => !inside.has(id))).toEqual(['f-id', 'f-kind', 'f-label', 'f-host', 'f-user']);
    for (const id of ['f-port', 'f-password', 'f-identityFile']) expect(inside.has(id)).toBe(true);
  });

  // Invariant: an untouched ssh Create sends the shown default mirror and omits the blank advanced fields.
  it('Create of an untouched ssh form posts the default mirror and no advanced config keys', async () => {
    const { user, tile, calls } = await openAdd({ remotes: [], kinds: SSH_FIRST });
    await user.type(byId(tile, 'f-id')!, 'box');
    await user.type(byId(tile, 'f-host')!, 'h');
    await submit(user, tile, 'Create');
    await waitFor(() => expect(lastBody(calls, 'POST', 'api/remotes')).toEqual({
      remoteId: 'box', kind: 'ssh', config: { host: 'h' }, mirror: { root: '/', exclude: ['/proc', '/dev', '/sys'] },
    }));
  });

  // Invariant: switching kind re-derives the mirror from the new kind's default, and clears the old config.
  it("switching kind re-derives the mirror default and drops the old kind's config", async () => {
    const { user, tile, calls } = await openAdd();
    await user.click(byId(tile, 'f-mirror-on')!);
    expect(checked(addTile(), 'f-mirror-on')).toBe(false);
    await user.type(byId(addTile(), 'f-container')!, 'c');
    await user.selectOptions(byId<HTMLSelectElement>(addTile(), 'f-kind')!, 'ssh');
    expect(checked(addTile(), 'f-mirror-on')).toBe(true);
    expect(byId(addTile(), 'f-mirror-root')!.disabled).toBe(false);
    await user.selectOptions(byId<HTMLSelectElement>(addTile(), 'f-kind')!, 'docker');
    expect(checked(addTile(), 'f-mirror-on')).toBe(true);
    expect(byId(addTile(), 'f-container')!.value).toBe('');
    await user.type(byId(addTile(), 'f-id')!, 'x');
    await submit(user, addTile(), 'Create');
    await waitFor(() => expect(lastBody(calls, 'POST', 'api/remotes')?.config).toEqual({}));
  });

  // Invariant: the mirror checkbox enables and disables its two fields; the group's open state is the
  // operator's and survives the box being ticked and unticked.
  it('the box enables the mirror fields; the group stays as the operator opened it', async () => {
    const { user, tile } = await openAdd();
    await user.click(detailsOf(tile).querySelector('summary')!);
    expect(detailsOf(addTile()).open).toBe(true);
    await user.click(byId(addTile(), 'f-mirror-on')!);
    expect(byId(addTile(), 'f-mirror-root')!.disabled).toBe(true);
    expect(byId<HTMLTextAreaElement>(addTile(), 'f-mirror-exclude')!.disabled).toBe(true);
    expect(summaryState(addTile())).toBe(' · no mirror');
    expect(detailsOf(addTile()).open).toBe(true);
    await user.click(byId(addTile(), 'f-mirror-on')!);
    expect(byId(addTile(), 'f-mirror-root')!.disabled).toBe(false);
    expect(detailsOf(addTile()).open).toBe(true);
    await user.click(detailsOf(addTile()).querySelector('summary')!);
    expect(detailsOf(addTile()).open).toBe(false);
  });

  // Invariant: the summary tracks typing, and a cleared root says so.
  it('typing a mirror root updates the Advanced summary', async () => {
    const { user, tile } = await openAdd();
    const root = byId(tile, 'f-mirror-root')!;
    await user.clear(root);
    expect(summaryState(addTile())).toBe(' · mirror (no root)');
    await user.type(root, '/srv');
    expect(summaryState(addTile())).toBe(' · mirror /srv');
  });

  // Invariant: the mirror value really leaves, in all three docker shapes.
  it('Create posts the docker default untouched, null unticked, and the typed advertisement', async () => {
    const posted = async (edit?: (tile: HTMLElement, user: ReturnType<typeof userEvent.setup>) => Promise<void>) => {
      const { user, tile, calls, unmount } = await openAdd({ remotes: [] });
      await user.type(byId(tile, 'f-id')!, 'app');
      await edit?.(tile, user);
      await submit(user, addTile(), 'Create');
      await waitFor(() => expect(lastBody(calls, 'POST', 'api/remotes')).toBeTruthy());
      unmount();
      return lastBody(calls, 'POST', 'api/remotes')!;
    };
    expect((await posted()).mirror).toEqual({ root: '/', exclude: ['/proc', '/dev', '/sys'] });
    expect((await posted(async (t, u) => { await u.click(byId(t, 'f-mirror-on')!); })).mirror).toBeNull();
    expect((await posted(async (t, u) => {
      await u.clear(byId(t, 'f-mirror-root')!);
      await u.type(byId(t, 'f-mirror-root')!, '/srv/app');
      await u.clear(byId<HTMLTextAreaElement>(t, 'f-mirror-exclude')!);
      await u.type(byId<HTMLTextAreaElement>(t, 'f-mirror-exclude')!, '/proc{Enter}/dev{Enter}');
    })).mirror).toEqual({ root: '/srv/app', exclude: ['/proc', '/dev'] });
  });

  // Invariant: with no served defaults the mirror half is absent (no invented defaults), the Advanced
  // group still carries the advanced config field, and Create omits the mirror key.
  it('with no served defaults the mirror half is absent, the group stays, and Create omits mirror', async () => {
    const { user, tile, calls } = await openAdd({ remotes: [], mirrorDefaults: null });
    expect(byId(tile, 'f-mirror-on')).toBeNull();
    expect(byId(tile, 'f-mirror-exclude')).toBeNull();
    expect(controlIds(tile)).toEqual(['f-id', 'f-kind', 'f-label', 'f-container', 'f-user']);
    expect(byId(detailsOf(tile), 'f-user')).toBeTruthy();
    expect(detailsOf(tile).open).toBe(false);
    expect(summaryState(tile)).toBe('');
    await user.type(byId(tile, 'f-id')!, 'app');
    await submit(user, tile, 'Create');
    await waitFor(() => expect(lastBody(calls, 'POST', 'api/remotes')).toBeTruthy());
    expect('mirror' in lastBody(calls, 'POST', 'api/remotes')!).toBe(false);
  });

  // Invariant: an advanced config field renders inside the Advanced group, not with the connection fields.
  it('an advanced config field renders inside Advanced, not in the connection block', async () => {
    const { tile } = await openAdd();
    const details = detailsOf(tile);
    expect(byId(details, 'f-user')).toBeTruthy();
    expect(byId(details, 'f-container')).toBeNull();
    expect(byId(tile, 'f-container')).toBeTruthy();
    expect(within(details).getByText('Run as (optional)')).toBeTruthy();
  });

  // Invariant: the typed identity leaves; an untouched one is omitted, never sent as ''.
  it('Create posts the typed identity, and omits it when left empty', async () => {
    const posted = async (typed: string | null) => {
      const { user, tile, calls, unmount } = await openAdd({ remotes: [] });
      await user.type(byId(tile, 'f-id')!, 'app');
      await user.type(byId(tile, 'f-container')!, 'ctr');
      if (typed !== null) await user.type(byId(tile, 'f-user')!, typed);
      await submit(user, tile, 'Create');
      await waitFor(() => expect(lastBody(calls, 'POST', 'api/remotes')).toBeTruthy());
      unmount();
      return lastBody(calls, 'POST', 'api/remotes')!.config;
    };
    expect(await posted('node')).toEqual({ container: 'ctr', user: 'node' });
    expect(await posted(null)).toEqual({ container: 'ctr' });
  });

  // Invariant: the form shows labels and controls only; every hint lives in a tooltip linked from its
  // input and its "?", hidden until asked for — on both kinds.
  it('shows labels and inputs, and every hint only in a linked, hidden tooltip', async () => {
    const { user, tile } = await openAdd();
    const check = (root: HTMLElement, pairs: [string, string | RegExp][]) => {
      const shown = visibleText(root);
      for (const [inputId, hint] of pairs) {
        const input = byId(root, inputId)!;
        const tipId = input.getAttribute('aria-describedby');
        expect(tipId, `${inputId} is described`).toBeTruthy();
        const body = document.getElementById(tipId!)!;
        expect(body.getAttribute('role')).toBe('tooltip');
        expect(body.hidden, `${inputId}'s tip is hidden by default`).toBe(true);
        if (typeof hint === 'string') {
          expect(body.textContent).toBe(hint);
          if (hint !== 'optional') expect(shown.includes(hint), `"${hint}" is not visible`).toBe(false);
        } else {
          expect(body.textContent).toMatch(hint);
        }
        // The "?" trigger: a mirror checkbox is a button described by the same tip.
        const trigger = [...root.querySelectorAll(`button[aria-describedby="${tipId}"]:not([role="checkbox"])`)];
        expect(trigger, `${inputId}'s tip has one trigger`).toHaveLength(1);
        expect(trigger[0].getAttribute('aria-label')).toMatch(/^About \S/);
      }
      expect(shown).not.toMatch(/Lower-case letters|asks for the mirror once|session root becomes|One absolute path/);
    };
    check(tile, [
      ['f-id', /^Lower-case letters, digits, dot, dash, underscore\./],
      ['f-container', 'the container'], ['f-user', 'the identity'],
      ['f-mirror-on', /Changing them does not switch this remote off\.$/],
      ['f-mirror-root', /session root becomes the image of this path/],
      ['f-mirror-exclude', /^One absolute path per line/],
    ]);
    await user.selectOptions(byId<HTMLSelectElement>(tile, 'f-kind')!, 'ssh');
    check(addTile(), REAL_SSH.configFields.map((f) => [`f-${f.name}`, f.hint!]));
  });

  // Invariant: a secret is a password input, never prefilled, and only it is masked.
  it('a secret field is a password input and is never prefilled', async () => {
    const { tile, unmount } = await openAdd({ remotes: [], kinds: [REAL_SSH] });
    const pw = byId(tile, 'f-password')!;
    expect(pw.type).toBe('password');
    expect(pw.getAttribute('autocomplete')).toBe('new-password');
    expect(pw.value).toBe('');
    expect(byId(tile, 'f-host')!.type).toBe('text');
    unmount();

    const leaked = { ...pwRemote(['password']), config: { host: 'h', password: 'leaked' } };
    const { form } = await openEdit('pw-box', { remotes: [leaked], kinds: [REAL_SSH] });
    expect(byId(form, 'f-password')!.value).toBe('');
    expect(form.innerHTML.includes('leaked')).toBe(false);
  });
});

describe('the edit form', () => {
  // Invariant: Edit opens inside its own card only, pre-filled, without the remoteId (never renamed),
  // and keeps the gate-reset warning visible.
  it('opens inline on its own card, pre-filled, and warns about the gate', async () => {
    const { form } = await openEdit('ssh-down');
    expect(controlIds(form)).toEqual(['f-label', 'f-host', 'f-user', 'f-port', 'f-password', 'f-identityFile', 'f-mirror-on', 'f-mirror-root', 'f-mirror-exclude']);
    expect(byId(form, 'f-host')!.value).toBe('box');
    expect(byId(form, 'f-user')!.value).toBe('me');
    expect(byId(form, 'f-label')!.value).toBe('Box');
    expect(byId(form, 'f-label')!.placeholder).toBe('ssh-down');
    expect(visibleText(form)).toMatch(/Changing a connection value switches this remote off\./);
    for (const id of ['on-up', 'off-up', 'on-down']) expect(cardEl(id).querySelector('form')).toBeNull();
    expect(screen.getAllByRole('textbox', { name: 'Label' })).toHaveLength(1);
  });

  // Invariant: a custom-mirrored remote opens Advanced, ticked and pre-filled with what is stored.
  it('a custom-mirrored remote opens the group, ticked and pre-filled', async () => {
    const { form } = await openEdit('ssh-down');
    expect(detailsOf(form).open).toBe(true);
    expect(checked(form, 'f-mirror-on')).toBe(true);
    expect(byId(form, 'f-mirror-root')!.value).toBe(STORED_MIRROR.root);
    expect(byId<HTMLTextAreaElement>(form, 'f-mirror-exclude')!.value).toBe(STORED_MIRROR.exclude.join('\n'));
    expect(byId(form, 'f-mirror-root')!.disabled).toBe(false);
  });

  // Invariant: an opted-out remote stays collapsed and unticked; its stored null is never re-defaulted,
  // while ticking would offer the served defaults.
  it('an unmirrored remote stays collapsed and unticked, summary "· no mirror"', async () => {
    const { form } = await openEdit('ssh-plain', { remotes: [SSH_PLAIN] });
    expect(detailsOf(form).open).toBe(false);
    expect(checked(form, 'f-mirror-on')).toBe(false);
    expect(summaryTitle(form)).toBe('Advanced');
    expect(summaryState(form)).toBe(' · no mirror');
    expect(byId(form, 'f-mirror-root')!.value).toBe(MIRROR_DEFAULTS.root);
  });

  // Invariant: Advanced opens for a stored advanced value or a custom mirror, and not for a default one.
  it('opens Advanced per the predicate', async () => {
    const opens = async (remote: WorkingRemote) => {
      const { form, unmount } = await openEdit(remote.remoteId, { remotes: [remote] });
      const d = detailsOf(form);
      const result = { open: d.open, summary: summaryState(form) };
      unmount();
      return result;
    };
    expect((await opens({ ...SSH_PLAIN, config: { host: 'h', port: 2222 } })).open).toBe(true);
    expect((await opens({ ...SSH_PLAIN, config: { host: 'h', identityFile: '/k' } })).open).toBe(true);
    expect((await opens({ ...SSH_PLAIN, storedSecrets: ['password'] })).open).toBe(true);
    expect((await opens({ ...SSH_PLAIN, mirror: STORED_MIRROR })).open).toBe(true);
    expect((await opens(REMOTES.find((r) => r.remoteId === 'off-up') as WorkingRemote)).open).toBe(true);
    expect(await opens({ ...SSH_PLAIN, mirror: MIRROR_DEFAULTS })).toEqual({ open: false, summary: ' · mirror /' });
  });

  // Invariant: an unchanged Save re-sends the stored record, advanced config and mirror included.
  it('Save of an unchanged ssh remote with a stored port re-sends the stored record', async () => {
    const remote = { ...SSH_PLAIN, config: { host: 'h', port: 2222 }, mirror: STORED_MIRROR };
    const { user, form, calls } = await openEdit('ssh-plain', { remotes: [remote] });
    await submit(user, form, 'Save');
    await waitFor(() => expect(lastBody(calls, 'PATCH', 'api/remotes/ssh-plain')).toEqual({
      label: 'Plain', config: { host: 'h', port: 2222 }, mirror: STORED_MIRROR,
    }));
  });

  // Invariant: a hand-edited mirror degrades the form instead of crashing the page.
  it('a hand-edited mirror does not crash the edit form', async () => {
    const broken = REMOTES.map((r) => (r.remoteId === 'off-up' ? { ...r, mirror: { root: '/srv', exclude: 'not-an-array' } } : r));
    const { form } = await openEdit('off-up', { remotes: broken });
    expect(screen.getAllByRole('article')).toHaveLength(broken.length);
    expect(byId(form, 'f-mirror-root')!.value).toBe('/srv');
    expect(byId<HTMLTextAreaElement>(form, 'f-mirror-exclude')!.value).toBe('');
  });

  // Invariant: the edit note's visible line is the consequence; its tip names Run as and scopes the
  // exemption to the mirror.
  it('the edit note names Run as, and scopes its exemption to the mirror', async () => {
    const { form } = await openEdit('on-up');
    const tip = document.getElementById('f-note-tip')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toMatch(/Run as/);
    expect(tip.textContent).toMatch(/mirror settings/);
    expect(form.querySelector('button[aria-label="About changing a connection value"]')!.getAttribute('aria-describedby')).toBe('f-note-tip');
    expect(visibleText(form)).not.toMatch(/Including a password/);
  });

  // Invariant: a stored identity is pre-filled in Advanced and sent back unchanged on Save.
  it('Edit pre-fills a stored identity, and Save sends it back unchanged', async () => {
    const { user, form, calls } = await openEdit('off-up');
    expect(byId(form, 'f-user')!.value).toBe('node');
    expect(byId(detailsOf(form), 'f-user')).toBeTruthy();
    expect(byId(form, 'f-container')!.value).toBe('app2');
    await submit(user, form, 'Save');
    await waitFor(() => expect(lastBody(calls, 'PATCH', 'api/remotes/off-up')?.config).toEqual({ container: 'app2', user: 'node' }));
  });

  // Invariant: a retyped identity carries the new value, and a cleared one is omitted.
  it('Edit sends the retyped identity, and can clear it', async () => {
    const saved = async (value: string) => {
      const { user, form, calls, unmount } = await openEdit('off-up');
      await user.clear(byId(form, 'f-user')!);
      if (value) await user.type(byId(form, 'f-user')!, value);
      await submit(user, form, 'Save');
      await waitFor(() => expect(lastBody(calls, 'PATCH', 'api/remotes/off-up')).toBeTruthy());
      unmount();
      return lastBody(calls, 'PATCH', 'api/remotes/off-up')!.config;
    };
    expect(await saved('1000:1000')).toEqual({ container: 'app2', user: '1000:1000' });
    expect(await saved('')).toEqual({ container: 'app2' });
  });

  // Invariant: the keep placeholder and the Clear checkbox appear only for a stored secret.
  it('shows the keep placeholder and the Clear checkbox only for a stored secret', async () => {
    const stored = await openEdit('pw-box', { remotes: [pwRemote(['password'])], kinds: [REAL_SSH] });
    expect(byId(stored.form, 'f-password')!.placeholder).toBe('stored — leave blank to keep');
    expect(within(stored.form).getByRole('checkbox', { name: 'Clear stored password' }).id).toBe('f-password-clear');
    stored.unmount();
    const none = await openEdit('pw-box', { remotes: [pwRemote([])], kinds: [REAL_SSH] });
    expect(byId(none.form, 'f-password')!.placeholder).not.toBe('stored — leave blank to keep');
    expect(within(none.form).queryByRole('checkbox', { name: /Clear stored/ })).toBeNull();
  });

  // Invariant: blank keeps a stored secret (omitted), Clear sends null, a typed one goes untrimmed.
  it('Save omits a blank secret, sends null once Clear is ticked, and never trims a typed one', async () => {
    const saved = async (act?: (form: HTMLElement, user: ReturnType<typeof userEvent.setup>) => Promise<void>) => {
      const { user, form, calls, unmount } = await openEdit('pw-box', { remotes: [pwRemote(['password'])], kinds: [REAL_SSH] });
      await act?.(form, user);
      await submit(user, form, 'Save');
      await waitFor(() => expect(lastBody(calls, 'PATCH', 'api/remotes/pw-box')).toBeTruthy());
      unmount();
      return lastBody(calls, 'PATCH', 'api/remotes/pw-box')!.config;
    };
    expect(await saved()).toEqual({ host: '10.0.0.5', user: 'dev' });
    expect(await saved(async (f, u) => { await u.click(within(f).getByRole('checkbox', { name: 'Clear stored password' })); }))
      .toEqual({ host: '10.0.0.5', user: 'dev', password: null });
    expect(await saved(async (f, u) => { await u.type(byId(f, 'f-password')!, ' new pw '); }))
      .toEqual({ host: '10.0.0.5', user: 'dev', password: ' new pw ' });
  });
});

describe('submitting', () => {
  // Invariant (Δ1): a refused Create shows its error inside the form, which stays open with its
  // values; the page's notices stay empty. A card action's failure still goes to the notices.
  it('a refused Create shows its error in the form, not the banner', async () => {
    const error = 'remoteId must match ^[a-z0-9][a-z0-9._-]{0,63}$ (got "Bad Id")';
    const { user, tile } = await openAdd({
      reply: (path, method) => {
        if (method === 'POST' && path === 'api/remotes') return { status: 400, body: { error } };
        if (method === 'POST' && path.endsWith('/connect')) return { status: 502, body: { error: 'transport said no' } };
        return null;
      },
    });
    await user.type(byId(tile, 'f-id')!, 'Bad Id');
    await submit(user, tile, 'Create');
    expect(await within(addTile()).findByText(error)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Notices' })).toBeNull();
    expect(byId(addTile(), 'f-id')!.value).toBe('Bad Id');
    expect(location.search).toBe('?add');

    await user.click(card('off-up').getByRole('button', { name: 'Connect' }));
    const notices = await screen.findByRole('region', { name: 'Notices' });
    expect(await within(notices).findByText('transport said no')).toBeTruthy();
    expect(within(notices).queryByText(error)).toBeNull();
    expect(within(addTile()).getByText(error)).toBeTruthy();
  });

  // Invariant: the in-form error clears on the next submit, on Cancel and on a new draft.
  it('the in-form error clears on resubmit, cancel and a new draft', async () => {
    let refuse = true;
    const { user, tile } = await openAdd({
      reply: (path, method) => (method === 'POST' && path === 'api/remotes' && refuse ? { status: 400, body: { error: 'refused' } } : null),
    });
    await submit(user, tile, 'Create');
    await within(addTile()).findByText('refused');
    refuse = false;
    await submit(user, addTile(), 'Create');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New remote' })).toBeNull());

    refuse = true;
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    await submit(user, addTile(), 'Create');
    await within(addTile()).findByText('refused');
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(within(addTile()).queryByText('refused')).toBeNull();
    await submit(user, addTile(), 'Create');
    await within(addTile()).findByText('refused');
    await user.click(within(addTile()).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(within(addTile()).queryByText('refused')).toBeNull();
  });

  // Invariant (Δ2): Enter in a single-line field submits once; Enter in Excluded paths is a newline.
  it('Enter submits; Enter in Excluded paths does not', async () => {
    const { user, tile, calls } = await openAdd({ remotes: [] });
    await user.click(detailsOf(tile).querySelector('summary')!);
    const exclude = byId<HTMLTextAreaElement>(addTile(), 'f-mirror-exclude')!;
    await user.click(exclude);
    await user.keyboard('{End}{Enter}/tmp');
    expect(exclude.value).toBe('/proc\n/dev\n/sys\n/tmp');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await user.type(byId(addTile(), 'f-id')!, 'app{Enter}');
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(lastBody(calls, 'POST', 'api/remotes')).toMatchObject({ remoteId: 'app', mirror: { exclude: ['/proc', '/dev', '/sys', '/tmp'] } });
  });

  // Invariant: while submitting, Create and Cancel are disabled and Create spins; Enter does not
  // resubmit; success returns to the list with the draft cleared.
  it('submitting disables the actions, then success returns to the list', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { user, tile, calls } = await openAdd({
      reply: async (path, method) => (method === 'POST' && path === 'api/remotes' ? (await held, { status: 201, body: {} }) : null),
    });
    await user.type(byId(tile, 'f-id')!, 'app');
    await submit(user, tile, 'Create');
    const create = within(addTile()).getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.querySelector('svg.animate-spin')).toBeTruthy();
    expect((within(addTile()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(byId(addTile(), 'f-id')!, '{Enter}');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New remote' })).toBeNull());
    expect(location.search).toBe('');
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(byId(addTile(), 'f-id')!.value).toBe('');
  });

  // Invariant: Cancel returns to the list and drops the draft, sending nothing.
  it('Cancel returns to the list and drops the draft', async () => {
    const { user, tile, calls } = await openAdd();
    await user.type(byId(tile, 'f-id')!, 'half-typed');
    await user.click(within(tile).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'New remote' })).toBeNull();
    expect(location.search).toBe('');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(byId(addTile(), 'f-id')!.value).toBe('');
  });
});
