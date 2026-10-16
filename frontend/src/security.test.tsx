// Pins Part 2's content rule end to end: remote- and cc-written text renders as text, never markup,
// and nothing typed reaches a class or a style.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { stripeClass } from '@/lib/cardState.mjs';
import { REMOTES, card, cardEl, renderApp } from '@/test/fixtures';
import type { Remote, WorkingRemote } from '@/lib/types';

const HOSTILE = ['<img src=x onerror=alert(1)>', '<style>*{color:red}</style>', '<script>alert(1)</script>', '<iframe src=x></iframe>'];
const evil = (i: number, where: string) => `${HOSTILE[i % HOSTILE.length]} ${where}`;

function assertInert(texts: string[]) {
  expect(document.querySelectorAll('img, script, style, iframe')).toHaveLength(0);
  const all = document.body.textContent ?? '';
  for (const t of texts) expect(all.includes(t), `"${t}" is on the page as text`).toBe(true);
  for (const el of document.querySelectorAll('[style]')) {
    for (const t of texts) expect(el.getAttribute('style')!.includes(t)).toBe(false);
  }
}

describe('content renders as text', () => {
  // Invariant: hostile text in every content field — label, probe detail, baseline detail, a broken
  // record's message, registration detail and rows, and an action's error and warning — is shown
  // verbatim and creates no element.
  it('hostile strings everywhere stay text', async () => {
    const user = userEvent.setup();
    const texts = {
      label: evil(0, 'label'), detail: evil(1, 'probe'), baseline: evil(2, 'baseline'), broken: evil(3, 'broken'),
      regDetail: evil(0, 'reg detail'), regRow: evil(1, 'reg row'), error: evil(2, 'error'), warning: evil(3, 'warning'),
    };
    const remotes: Remote[] = [
      {
        ...(REMOTES[0] as WorkingRemote), label: texts.label, reachability: { connected: false, detail: texts.detail },
        baseline: { state: 'unsupported', missing: [{ capability: 'readDir', probe: 'find', detail: texts.baseline }] },
      },
      { ...(REMOTES[2] as WorkingRemote) },
      { remoteId: 'future', broken: { reason: 'schema', message: texts.broken } },
    ];
    await renderApp({
      remotes,
      registration: { state: 'blocked', detail: texts.regDetail, rows: [{ id: 'docker', state: 'blocked', message: texts.regRow }] },
      reply: (path, method) => {
        if (method === 'POST' && path.endsWith('/connect')) return { status: 502, body: { error: texts.error } };
        if (method === 'POST' && path.endsWith('/disconnect')) return { body: { warning: texts.warning } };
        return null;
      },
    });
    await user.click(card('off-up').getByRole('button', { name: 'Connect' }));
    await within(await screen.findByRole('region', { name: 'Notices' })).findByText(texts.error);
    await user.click(card('on-up').getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(document.body.textContent).toContain(texts.warning));
    assertInert([texts.label, texts.detail, texts.baseline, texts.broken, texts.regDetail, texts.regRow, texts.warning]);

    // The connect error was replaced by the warning; it rendered inertly while it was shown.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(document.querySelectorAll('img, script, style, iframe')).toHaveLength(0);
  });

  // Invariant (H8): a hostile remoteId still yields exactly one stripe class from the fixed set; no
  // class token on the card root comes from it, and the root carries no style.
  it('a hostile remoteId reaches no class and no style', async () => {
    const ids = ['x" style="color:red', 'bg-primary stripe-9', '<img src=x>'];
    const base = REMOTES[2] as WorkingRemote;
    await renderApp({ remotes: [base, ...ids.map((remoteId) => ({ ...base, remoteId, label: '' }))] });
    const reference = [...cardEl(base.remoteId).classList].filter((c) => !/^stripe-/.test(c));
    for (const id of ids) {
      const root = cardEl(id);
      const stripes = [...root.classList].filter((c) => /^stripe-/.test(c));
      expect(stripes).toEqual([stripeClass(id)]);
      expect(stripes[0]).toMatch(/^stripe-[0-7]$/);
      expect([...root.classList].filter((c) => !/^stripe-/.test(c))).toEqual(reference);
      expect(root.hasAttribute('style')).toBe(false);
      expect(root.querySelector('[data-slot="cred-value"]')?.textContent).toBe(id);
    }
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
