import { useId, type ReactNode } from 'react';
import { BoxIcon, LoaderCircleIcon, TerminalIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CredRow } from '@/components/CredRow';
import {
  GATE_COPY, baselineNotice, cardAlert, gateStatus, mirrorSummary, probeStatus, stripeClass,
} from '@/lib/cardState.mjs';
import { DANGER_BUTTON, DOT, GATE_ON_BUTTON, TONE } from '@/lib/tone';
import { cn } from '@/lib/utils';
import type { BrokenRemote, KindDescriptor, WorkingRemote } from '@/lib/types';

const KIND_ICON: Record<string, typeof BoxIcon> = { docker: BoxIcon, ssh: TerminalIcon };
const BASELINE_BADGE = { ok: 'success', unsupported: 'destructive' } as const;

/** What a card's action is busy with, so that one button shows the spinner. */
export type CardAction = 'connect' | 'disconnect' | 'delete' | 'submit';

const Spinner = ({ on }: { on: boolean }) => (on ? <LoaderCircleIcon className="animate-spin" /> : null);

function Dot({ level }: { level: keyof typeof DOT }) {
  // Decorative: the probe word beside it carries the meaning.
  return <span aria-hidden data-slot="probe-dot" className={cn('size-2 shrink-0 rounded-full', DOT[level])} />;
}

/**
 * One remote. The GATE word and the PROBE word are two different facts, so they are two different
 * elements: collapsing them into one is the single mistake this card design exists to prevent
 * (.wiki/gotchas/gate-versus-probe.md). The action button is how the operator moves the gate; it
 * is not a switch, so an in-flight failure cannot look like a state.
 */
export function RemoteCard({ remote, descriptor, busy, onGate, onEdit, onDelete, children }: {
  remote: WorkingRemote;
  descriptor: KindDescriptor | null;
  busy: CardAction | undefined;
  onGate: (verb: 'connect' | 'disconnect') => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The edit form, when it is open on this card. */
  children?: ReactNode;
}) {
  const titleId = useId();
  const gate = gateStatus(remote);
  const probe = probeStatus(remote);
  const alert = cardAlert(remote);
  const notice = baselineNotice(remote);
  const mirror = mirrorSummary(remote);
  const baselineState = remote.baseline?.state ?? 'unknown';
  const gateCopy = (GATE_COPY as Record<string, string | undefined>)[remote.kind];
  const KindIcon = KIND_ICON[remote.kind];
  const isBusy = busy !== undefined;

  return (
    <Card
      role="article"
      aria-labelledby={titleId}
      aria-busy={isBusy}
      data-remote-id={remote.remoteId}
      className={cn('gap-3 border-l-[6px] px-4 py-3', stripeClass(remote.remoteId))}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot level={probe.level} />
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold">{remote.label || remote.remoteId}</h2>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <span data-slot="gate-word" className={cn('font-semibold', gate.enabled ? TONE.ok : TONE.muted)}>{gate.word}</span>
          <span data-slot="probe-word" className={TONE.muted}>{probe.word}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-mono">
          {KindIcon && <KindIcon aria-hidden />}
          {descriptor?.label ?? remote.kind}
        </Badge>
        <Badge
          variant={BASELINE_BADGE[baselineState as keyof typeof BASELINE_BADGE] ?? 'outline'}
          className={cn('font-mono', baselineState === 'unknown' && TONE.muted)}
        >
          baseline {baselineState}
        </Badge>
        {mirror && <Badge variant="secondary" className="font-mono">{mirror}</Badge>}
      </div>

      {/* The transport's OWN words, never a paraphrase: for ssh the ControlPath, for docker the image. */}
      {probe.detail && <p className="text-xs break-words text-muted-foreground">{probe.detail}</p>}

      {alert && (
        <Alert role="note" variant={alert.level === 'err' ? 'destructive' : 'warning'}>
          <AlertDescription className="whitespace-pre-wrap">{alert.text}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert role="note" variant="destructive">
          <AlertTitle className="line-clamp-none">{notice.title}</AlertTitle>
          <AlertDescription className="max-h-40 overflow-auto font-mono text-xs">
            {notice.lines.map((line, i) => <div key={i} className="break-words whitespace-pre-wrap">{line}</div>)}
          </AlertDescription>
        </Alert>
      )}

      <CredRow remoteId={remote.remoteId} />

      {gateCopy && <p className="text-xs text-muted-foreground">{gateCopy}</p>}

      <div className="flex flex-wrap gap-2">
        {gate.enabled ? (
          <Button type="button" variant="outline" size="sm" className={DANGER_BUTTON} disabled={isBusy} onClick={() => onGate('disconnect')}>
            <Spinner on={busy === 'disconnect'} />
            Disconnect
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className={GATE_ON_BUTTON} disabled={isBusy} onClick={() => onGate('connect')}>
            <Spinner on={busy === 'connect'} />
            Connect
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={onEdit}>Edit</Button>
        <Button type="button" variant="outline" size="sm" className={DANGER_BUTTON} disabled={isBusy} onClick={onDelete}>
          <Spinner on={busy === 'delete'} />
          Delete
        </Button>
      </div>

      {children}
    </Card>
  );
}

/**
 * A record the store could not read. Still SHOWN: a shorter list than the user configured would be
 * the wrong answer. Delete only: Connect would be a button that cannot work, and there is no usable
 * id to hand to a project.
 */
export function BrokenCard({ remote, busy, onDelete }: {
  remote: BrokenRemote;
  busy: CardAction | undefined;
  onDelete: () => void;
}) {
  const titleId = useId();
  const probe = probeStatus(remote);
  const alert = cardAlert(remote);
  return (
    <Card
      role="article"
      aria-labelledby={titleId}
      aria-busy={busy !== undefined}
      data-remote-id={remote.remoteId}
      className="gap-3 border-l-[6px] border-l-destructive px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot level={probe.level} />
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold">{remote.remoteId}</h2>
        <span data-slot="probe-word" className={cn('shrink-0 text-xs', TONE.muted)}>{probe.word}</span>
      </div>
      {alert && (
        <Alert role="note" variant="destructive">
          <AlertDescription className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">{alert.text}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className={DANGER_BUTTON} disabled={busy !== undefined} onClick={onDelete}>
          <Spinner on={busy === 'delete'} />
          Delete
        </Button>
      </div>
    </Card>
  );
}
