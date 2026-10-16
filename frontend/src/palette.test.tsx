// Pins the colour roles: status is success / warning / destructive and never primary; the primary
// fill is a form's Create/Save and nothing else.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { card, cardEl, renderApp } from '@/test/fixtures';

const has = (el: Element | null, cls: string) => !!el && el.classList.contains(cls);
const slot = (id: string, name: string) => cardEl(id).querySelector(`[data-slot="${name}"]`);
const noPrimary = (el: Element | null) => !!el && ![...el.classList].some((c) => c.includes('primary'));

describe('status colours', () => {
  // Invariant: each status element takes its status token, and none takes primary.
  it('status takes success / warning / destructive, never primary', async () => {
    await renderApp();
    const statusEls: [Element | null, string][] = [
      [slot('on-up', 'gate-word'), 'text-success'],
      [slot('off-up', 'gate-word'), 'text-muted-foreground'],
      [slot('on-up', 'probe-dot'), 'bg-success'],
      [slot('on-down', 'probe-dot'), 'bg-warning'],
      [slot('future', 'probe-dot'), 'bg-muted-foreground'],
      [card('on-up').getByText('baseline ok'), 'text-success'],
      [card('ssh-down').getByText('baseline unsupported'), 'text-destructive'],
      [screen.getByText('registration: ok'), 'text-success'],
      [card('on-down').getByRole('note'), 'text-warning'],
      [card('future').getByRole('note'), 'text-destructive'],
      [card('ssh-down').getAllByRole('note').find((n) => n.textContent?.includes('missing tooling')) ?? null, 'text-destructive'],
      [card('off-up').getByRole('button', { name: 'Connect' }), 'text-success'],
      [card('on-up').getByRole('button', { name: 'Disconnect' }), 'text-destructive'],
      [card('on-up').getByRole('button', { name: 'Delete' }), 'text-destructive'],
      [card('future').getByRole('button', { name: 'Delete' }), 'text-destructive'],
    ];
    for (const [el, cls] of statusEls) {
      expect(has(el, cls), `${el?.textContent || el?.getAttribute('data-slot')}: ${cls}`).toBe(true);
      expect(noPrimary(el), `${el?.textContent}: no primary`).toBe(true);
    }
    expect(has(cardEl('future'), 'border-l-destructive')).toBe(true);
  });

  // Invariant: a failing registration's pill is destructive.
  it('a blocked registration pill is destructive', async () => {
    await renderApp({ registration: { state: 'blocked', rows: [{ id: 'docker', state: 'blocked', message: 'no' }] } });
    const pill = screen.getByText('registration: blocked');
    expect(has(pill, 'text-destructive') && noPrimary(pill)).toBe(true);
  });
});

describe('the primary fill', () => {
  const filled = () => [...document.querySelectorAll('.bg-primary')];

  // Invariant: the only element carrying the exact `bg-primary` class is the open form's submit,
  // and submitting disables it.
  it('is the form submit and nothing else', async () => {
    const user = userEvent.setup();
    await renderApp({ reply: (path, method) => (method === 'POST' && path === 'api/remotes' ? new Promise(() => {}) : null) });
    expect(filled()).toEqual([]);
    await user.click(card('on-up').getByRole('button', { name: 'Edit' }));
    expect(filled()).toEqual([card('on-up').getByRole('button', { name: 'Save' })]);
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    const tile = within(screen.getByRole('region', { name: 'New remote' }));
    const create = tile.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(filled()).toEqual([create]);
    expect(create.type).toBe('submit');
    await user.click(create);
    await waitFor(() => expect(create.disabled).toBe(true));
  });
});
