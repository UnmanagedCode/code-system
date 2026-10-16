import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HintTip } from './HintTip';

function mount({ hover = false } = {}) {
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: hover && q === '(hover: hover)', addEventListener() {}, removeEventListener() {} })));
  render(
    <div>
      <input aria-label="before" />
      <div className="relative">
        <label htmlFor="f">Field</label>
        <HintTip id="f-tip" name="Field" text="What the field means." />
      </div>
      <input id="f" aria-describedby="f-tip" />
    </div>,
  );
  const btn = screen.getByRole('button', { name: 'About Field' });
  const body = document.getElementById('f-tip')!;
  const tip = btn.parentElement!;
  const is = (s: 'open' | 'dismissed') => tip.getAttribute(`data-${s}`) === 'true';
  return { btn, body, tip, is };
}

describe('HintTip', () => {
  // Invariant: the state machine — a tap toggles; Escape or a body click dismisses even under hover;
  // a dismissal holds until focusout, an unfocused mouseenter, a fresh focusin, or a "?" click;
  // focusout resets both.
  it('opens on click, dismisses on Escape or a body click, and resets on focusout', () => {
    const { btn, body, tip, is } = mount();

    fireEvent.click(btn);
    expect(is('open')).toBe(true);
    fireEvent.click(btn);
    expect(is('open')).toBe(false);

    fireEvent.click(btn);
    fireEvent.click(body);
    expect(is('open')).toBe(false);
    expect(is('dismissed')).toBe(true);
    fireEvent.mouseEnter(tip);
    expect(is('dismissed')).toBe(false);

    fireEvent.click(btn);
    fireEvent.blur(btn);
    fireEvent.click(body);
    fireEvent.focus(btn);
    expect(is('dismissed')).toBe(false);
    fireEvent.blur(btn);

    fireEvent.focus(btn);
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(is('dismissed')).toBe(true);
    fireEvent.mouseEnter(tip);
    fireEvent.mouseLeave(tip);
    expect(is('dismissed')).toBe(true);

    fireEvent.click(btn);
    expect(is('open') && !is('dismissed')).toBe(true);

    fireEvent.blur(btn);
    expect(is('open') || is('dismissed')).toBe(false);
  });

  // Invariant: the body is hidden by default and linked from the trigger; a tap shows it.
  it('is hidden by default, linked, and a tap shows it', async () => {
    const user = userEvent.setup();
    const { btn, body } = mount();
    expect(body.getAttribute('role')).toBe('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe('f-tip');
    expect(btn.getAttribute('type')).toBe('button');
    expect(body.hidden).toBe(true);
    expect(body.textContent).toBe('What the field means.');
    await user.click(btn);
    expect(body.hidden).toBe(false);
    await user.click(btn);
    expect(body.hidden).toBe(true);
  });

  // Invariant: keyboard focus shows it; a pointer's focus alone does not (the click toggle does).
  it('keyboard Tab shows it; a pointer focus alone does not', async () => {
    const user = userEvent.setup();
    const { btn, body } = mount();
    screen.getByRole('textbox', { name: 'before' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(btn);
    expect(body.hidden).toBe(false);
    await user.tab();
    expect(body.hidden).toBe(true);

    fireEvent.pointerDown(btn);
    fireEvent.focus(btn);
    expect(body.hidden).toBe(true);
  });

  // Invariant: hover shows it only where hover is real, and a dismissal beats both open and hover.
  it('hover shows it only with (hover: hover); dismissed beats open and hover', async () => {
    const none = mount();
    fireEvent.mouseEnter(none.tip);
    expect(none.body.hidden).toBe(true);
    cleanup();

    const { btn, body, tip } = mount({ hover: true });
    fireEvent.mouseEnter(tip);
    expect(body.hidden).toBe(false);
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(body.hidden).toBe(false);
    fireEvent.focus(btn);
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(body.hidden).toBe(true);
  });

  // Invariant: the tip borrows no primary colour: it is help, not a control or a status.
  it('takes no primary class', () => {
    const { btn, body } = mount();
    for (const el of [btn, body]) expect([...el.classList].some((c) => c.includes('primary'))).toBe(false);
  });
});
