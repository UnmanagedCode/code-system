import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/** How long "Copied" shows before the button reads "Copy" again. */
export const COPY_RESET_MS = 1200;

/**
 * THE HAND-OFF CONTRACT, made visible: this exact string goes into a cc project's Remote field, and
 * this card is the only place a user reads it.
 *
 * Copy is AWAITED and only confirmed on resolve. `navigator.clipboard` is absent in a non-secure
 * context, which is exactly this page inside cc's frame over plain http, and present-but-rejecting
 * when the permission is denied. Claiming "Copied" regardless would have the operator paste nothing
 * into cc believing the hand-off worked.
 */
export function CredRow({ remoteId }: { remoteId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteId = useId();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('no clipboard in this context');
      await navigator.clipboard.writeText(remoteId);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), COPY_RESET_MS);
    } catch {
      // LEFT ON SCREEN rather than reset: the operator has to do something, and the id beside it
      // is selectable text.
      setState('failed');
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">Remote</span>
        <code
          data-slot="cred-value"
          className="min-w-0 flex-1 rounded-md border bg-muted px-2 py-1 font-mono text-xs break-all select-all"
        >
          {remoteId}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-describedby={state === 'failed' ? noteId : undefined}
          onClick={copy}
        >
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select & copy' : 'Copy'}
        </Button>
      </div>
      {state === 'failed' && (
        <p id={noteId} className="text-xs text-muted-foreground">
          The browser would not give this page the clipboard — select the id and copy it by hand.
        </p>
      )}
      <p className="text-xs text-muted-foreground">Paste this into a code-conductor project's Remote field.</p>
    </div>
  );
}
