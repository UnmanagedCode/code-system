import { Alert, AlertDescription } from '@/components/ui/alert';
import { brokerLine } from '@/lib/cardState.mjs';
import type { BrokerStatus as Status } from '@/lib/types';

/**
 * The agent listener's line: shown only while an agent remote exists (the page asks only then).
 * Its reasons are the backend's own words, verbatim.
 */
export function BrokerStatus({ broker }: { broker: Status | null }) {
  const line = brokerLine(broker);
  if (!line) return null;
  return (
    <Alert role="status" variant={line.level === 'err' ? 'destructive' : 'default'} className={line.level === 'ok' ? 'text-muted-foreground' : undefined}>
      <AlertDescription className="break-words">
        <span data-slot="broker-line">{line.text}</span>
        {line.refusals.length > 0 && (
          <div className="mt-1">
            <span className="text-xs">Refused agents for remote ids no card has:</span>
            {line.refusals.map((r, i) => <pre key={i} className="font-mono text-xs whitespace-pre-wrap break-words">{r}</pre>)}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
