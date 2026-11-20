// The agent kind's card UI, through the real App over the stub backend: the secret is generated in
// the page, shown ONCE in the start command, gone after a re-render from the API, and replaceable
// only by generating a new one. The probe words and a named refusal come from the reachability data.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { DOCKER, addTile, card, cardEl, lastBody, renderApp, unknownBaseline, type Reply } from '@/test/fixtures';
import { kindDescriptors } from '@/test/backend';
import type { BrokerStatus, Remote, WorkingRemote } from '@/lib/types';

const AGENT = kindDescriptors().find((k) => k.kind === 'agent')!;
const KINDS = [DOCKER, AGENT];
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const BROKER: BrokerStatus = { listen: '0.0.0.0:7420', dialDefault: '127.0.0.1:7420', running: true, address: '0.0.0.0:7420', refusals: [] };

const agentRemote = (over: Partial<WorkingRemote> = {}): WorkingRemote => ({
  remoteId: 'host-a', kind: 'agent', label: 'Host A', enabled: false, config: {}, storedSecrets: ['secret'],
  mirror: null, baseline: unknownBaseline, reachability: { connected: false, detail: 'no agent connected' }, ...over,
});

// A backend whose remote list gains the created agent remote, and which serves the listener status.
function agentBackend(start: Remote[] = []) {
  const remotes = [...start];
  const reply: Reply = (path, method, body) => {
    if (path === 'api/agent/broker' && method === 'GET') return { body: BROKER };
    if (path === 'api/remotes' && method === 'POST') {
      const b = body as { remoteId: string };
      remotes.push(agentRemote({ remoteId: b.remoteId, label: b.remoteId }));
      return { status: 201, body: {} };
    }
    return undefined;
  };
  return { remotes, reply };
}

const commands = (id: string) => [...cardEl(id).querySelectorAll('[data-slot="agent-command"]')].map((e) => e.textContent ?? '');

describe('an agent remote', () => {
  // Invariant: the form has no input for the secret; Create sends a generated one, and the card then
  // offers both start commands carrying the remote id, that secret and the listener address.
  it('Create sends a generated secret, and the card shows it once in the start commands', async () => {
    const user = userEvent.setup();
    const backend = agentBackend();
    const { calls } = await renderApp({ remotes: backend.remotes, kinds: KINDS, reply: backend.reply });
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    await user.selectOptions(addTile().querySelector('select')!, 'agent');
    expect(addTile().querySelector('input#f-secret')).toBeNull();
    await user.type(addTile().querySelector<HTMLInputElement>('#f-id')!, 'host-a');
    await user.click(within(addTile()).getByRole('button', { name: 'Create' }));

    const sent = lastBody(calls, 'POST', 'api/remotes') as { config: { secret: string } };
    expect(sent.config.secret).toMatch(SECRET_RE);
    await waitFor(() => expect(commands('host-a')).toHaveLength(2));
    for (const c of commands('host-a')) {
      expect(c).toContain(`CODE_SYSTEM_AGENT_SECRET='${sent.config.secret}'`);
      expect(c).toContain('--remote host-a');
      expect(c).toContain('--connect 127.0.0.1:7420');
    }
    expect(commands('host-a')[0]).toContain('curl -fsS http://127.0.0.1:7420/agent.py');
  });

  // Invariant: the dial address is editable and every command follows it.
  it('the dial address is editable, and the commands follow it', async () => {
    const user = userEvent.setup();
    const backend = agentBackend();
    await renderApp({ remotes: backend.remotes, kinds: KINDS, reply: backend.reply });
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    await user.selectOptions(addTile().querySelector('select')!, 'agent');
    await user.type(addTile().querySelector<HTMLInputElement>('#f-id')!, 'host-a');
    await user.click(within(addTile()).getByRole('button', { name: 'Create' }));
    const dial = await waitFor(() => card('host-a').getByLabelText('Listener address, as the target reaches it'));
    await user.clear(dial);
    await user.type(dial, '10.0.0.9:7420');
    for (const c of commands('host-a')) expect(c).toContain('--connect 10.0.0.9:7420');
  });

  // Invariant: Copy puts the exact command on the clipboard.
  it('each command has a working copy button', async () => {
    const user = userEvent.setup();
    const backend = agentBackend();
    await renderApp({ remotes: backend.remotes, kinds: KINDS, reply: backend.reply });
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    await user.selectOptions(addTile().querySelector('select')!, 'agent');
    await user.type(addTile().querySelector<HTMLInputElement>('#f-id')!, 'host-a');
    await user.click(within(addTile()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(commands('host-a')).toHaveLength(2));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(card('host-a').getByRole('button', { name: 'Copy: Without a checkout' }));
    expect(writeText).toHaveBeenCalledWith(commands('host-a')[0]);
    await waitFor(() => expect(card('host-a').getByRole('button', { name: 'Copy: Without a checkout' }).textContent).toBe('Copied'));
    fireEvent.click(card('host-a').getByRole('button', { name: 'Copy: From a code-system checkout' }));
    expect(writeText).toHaveBeenLastCalledWith(commands('host-a')[1]);
  });

  // Invariant: after a re-render from the API alone (a reload), the secret is nowhere on the page,
  // and the only way to a command is a new secret.
  it('after a reload the secret is gone, and Edit offers Generate new secret', async () => {
    const user = userEvent.setup();
    const backend = agentBackend();
    const { calls } = await renderApp({ remotes: backend.remotes, kinds: KINDS, reply: backend.reply });
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    await user.selectOptions(addTile().querySelector('select')!, 'agent');
    await user.type(addTile().querySelector<HTMLInputElement>('#f-id')!, 'host-a');
    await user.click(within(addTile()).getByRole('button', { name: 'Create' }));
    const secret = (lastBody(calls, 'POST', 'api/remotes') as { config: { secret: string } }).config.secret;
    await waitFor(() => expect(commands('host-a')).toHaveLength(2));

    cleanup();
    await renderApp({ remotes: backend.remotes, kinds: KINDS, reply: backend.reply });
    expect(document.body.textContent).not.toContain(secret);
    expect(commands('host-a')).toHaveLength(0);
    await user.click(card('host-a').getByRole('button', { name: 'Edit' }));
    expect(cardEl('host-a').querySelector('input#f-secret')).toBeNull();
    expect(card('host-a').getByRole('button', { name: 'Generate new secret' })).toBeTruthy();
  });

  // Invariant: Generate new secret is a pending change the form says the consequence of, can be
  // undone before saving, and on Save sends a NEW secret — which the card then shows once.
  it('Generate new secret sends a new secret on Save and shows its command', async () => {
    const user = userEvent.setup();
    const backend = agentBackend([agentRemote()]);
    const { calls } = await renderApp({ remotes: backend.remotes, kinds: KINDS, reply: backend.reply });
    await user.click(card('host-a').getByRole('button', { name: 'Edit' }));
    await user.click(card('host-a').getByRole('button', { name: 'Generate new secret' }));
    expect(card('host-a').getByRole('note').textContent).toMatch(/disconnected.*switches off/);
    await user.click(card('host-a').getByRole('button', { name: 'Keep the current secret' }));
    await user.click(card('host-a').getByRole('button', { name: 'Save' }));
    expect((lastBody(calls, 'PATCH', 'api/remotes/host-a') as { config: object }).config).toEqual({});
    expect(commands('host-a')).toHaveLength(0);

    await user.click(card('host-a').getByRole('button', { name: 'Edit' }));
    await user.click(card('host-a').getByRole('button', { name: 'Generate new secret' }));
    await user.click(card('host-a').getByRole('button', { name: 'Save' }));
    const sent = (lastBody(calls, 'PATCH', 'api/remotes/host-a') as { config: { secret: string } }).config.secret;
    expect(sent).toMatch(SECRET_RE);
    await waitFor(() => expect(commands('host-a')[0]).toContain(`'${sent}'`));
    await user.click(card('host-a').getByRole('button', { name: 'Dismiss' }));
    expect(commands('host-a')).toHaveLength(0);
  });

  // Invariant: the probe words and a named refusal come from the reachability data, verbatim.
  it('connected and not connected, and a named refusal, come from reachability', async () => {
    const { reply } = agentBackend();
    await renderApp({
      kinds: KINDS,
      reply,
      remotes: [
        agentRemote({ remoteId: 'up', reachability: { connected: true, detail: "agent on 'box' connected from 10.0.0.2:5000" } }),
        agentRemote({ remoteId: 'down', enabled: true, reachability: { connected: false, detail: 'no agent connected; last refused: wrong-secret from 10.0.0.3:6000' } }),
      ],
    });
    expect(cardEl('up').querySelector('[data-slot="probe-word"]')!.textContent).toBe('agent connected');
    expect(card('up').getByText(/connected from 10\.0\.0\.2:5000/)).toBeTruthy();
    expect(cardEl('down').querySelector('[data-slot="probe-word"]')!.textContent).toBe('no agent connected');
    expect(card('down').getByText(/wrong-secret from 10\.0\.0\.3:6000/)).toBeTruthy();
    expect(card('down').getByRole('note').textContent).toMatch(/No agent is connected/);
  });

  // Invariant: the listener line appears only while an agent remote exists, and says why it is
  // not running, verbatim, with unknown-remote refusals listed.
  it('the listener line shows only with an agent remote, with its reason and refusals', async () => {
    await renderApp({ kinds: KINDS });
    expect(document.querySelector('[data-slot="broker-line"]')).toBeNull();
    cleanup();
    const down: BrokerStatus = {
      listen: '127.0.0.1:7420', dialDefault: '127.0.0.1:7420', running: false,
      error: 'cannot listen on 127.0.0.1:7420: the port is already in use by another process',
      refusals: [{ remoteId: 'ghost', reason: 'unknown-remote', peer: '10.0.0.4:1', at: '2026-11-20T00:00:00Z' }],
    };
    await renderApp({
      kinds: KINDS,
      remotes: [agentRemote()],
      reply: (path) => (path === 'api/agent/broker' ? { body: down } : undefined),
    });
    await waitFor(() => expect(document.querySelector('[data-slot="broker-line"]')!.textContent).toMatch(/already in use/));
    expect(screen.getByText(/'ghost': unknown-remote/)).toBeTruthy();
  });
});
