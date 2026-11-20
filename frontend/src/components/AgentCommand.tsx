import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { COPY_RESET_MS } from '@/components/CredRow';
import { agentCommands } from '@/lib/cardState.mjs';

/** One command and its copy button: the same awaited, confirmed-on-resolve copy as `CredRow`. */
function CommandRow({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteId = useId();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('no clipboard in this context');
      await navigator.clipboard.writeText(text);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), COPY_RESET_MS);
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Copy: ${label}`}
          aria-describedby={state === 'failed' ? noteId : undefined}
          onClick={copy}
        >
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select & copy' : 'Copy'}
        </Button>
      </div>
      <code data-slot="agent-command" className="rounded-md border bg-muted px-2 py-1 font-mono text-xs break-all select-all">{text}</code>
      {state === 'failed' && (
        <p id={noteId} className="text-xs text-muted-foreground">
          The browser would not give this page the clipboard — select the command and copy it by hand.
        </p>
      )}
    </div>
  );
}

/**
 * THE ONLY TIME THE SECRET IS SHOWN: right after Create or Generate new secret, from the page's
 * memory. The API never returns it, so after a reload the only way back is a new secret.
 */
export function AgentCommand({ remoteId, secret, dialDefault, onDismiss }: {
  remoteId: string;
  secret: string;
  /** The listener's address as seen from cc's own machine; the operator edits it for the target's view. */
  dialDefault: string;
  onDismiss: () => void;
}) {
  const [dial, setDial] = useState(dialDefault);
  const dialId = useId();
  const cmds = agentCommands({ dial, remoteId, secret });
  return (
    <section aria-label="Start the agent" className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-semibold">Start the agent on the target machine</p>
      <p className="text-xs text-muted-foreground">
        This is the only time the secret is shown. Linux, Python 3.9 or later; the agent reconnects by itself.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={dialId} className="text-xs text-muted-foreground">Listener address, as the target reaches it</Label>
        <Input id={dialId} className="font-mono" value={dial} onChange={(e) => setDial(e.target.value)} />
      </div>
      <CommandRow label="Without a checkout" text={cmds.curl} />
      <CommandRow label="From a code-system checkout" text={cmds.checkout} />
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
    </section>
  );
}
