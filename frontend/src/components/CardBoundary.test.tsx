import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardBoundary } from './CardBoundary';

function Thrower({ message }: { message: string | null }) {
  if (message !== null) throw new Error(message);
  return <p>drawn</p>;
}

describe('CardBoundary', () => {
  // Invariant: the fallback is handed the caught error's own message (that text is the card's reason),
  // the error stays inside the boundary, and a changed resetKey tries the card again.
  it('hands the fallback the error\'s message, contains it, and retries on a new resetKey', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = (resetKey: string, message: string | null) => (
      <div>
        <p>sibling</p>
        <CardBoundary resetKey={resetKey} fallback={(msg) => <p role="note">{`reason: ${msg}`}</p>}>
          <Thrower message={message} />
        </CardBoundary>
      </div>
    );
    const { rerender } = render(view('a', 'boom-1f3e'));
    expect(screen.getByRole('note').textContent).toBe('reason: boom-1f3e');
    expect(screen.getByText('sibling')).toBeTruthy();
    rerender(view('a', null));
    expect(screen.getByRole('note').textContent).toBe('reason: boom-1f3e');
    rerender(view('b', null));
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('drawn')).toBeTruthy();
  });
});
