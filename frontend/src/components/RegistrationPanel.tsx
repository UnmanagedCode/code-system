import { LoaderCircleIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { registrationView } from '@/lib/cardState.mjs';
import type { Registration } from '@/lib/types';

export interface Notice {
  level: 'err' | 'warn';
  text: string;
}

/**
 * The page's notices: the last card action's failure or warning, and the System registration state.
 * Text from the backend and from cc is shown verbatim: it already names the cause and the fix.
 */
export function RegistrationPanel({ notice, onDismiss, registration, retrying, onRetry }: {
  notice: Notice | null;
  onDismiss: () => void;
  registration: Registration | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const banner = registrationView(registration)?.banner ?? null;
  if (!notice && !banner) return null;
  return (
    <section aria-label="Notices" className="flex flex-col gap-2">
      {notice && (
        <Alert variant={notice.level === 'err' ? 'destructive' : 'warning'}>
          <AlertTitle>{notice.level === 'err' ? 'Action failed' : 'Warning'}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap break-words">{notice.text}</AlertDescription>
          <div className="col-start-2 mt-2">
            <Button type="button" variant="outline" size="sm" onClick={onDismiss}>Dismiss</Button>
          </div>
        </Alert>
      )}
      {banner?.kind === 'muted' && (
        <Alert role="status" className="text-muted-foreground">
          <AlertDescription className="break-words">{banner.text}</AlertDescription>
        </Alert>
      )}
      {banner?.kind === 'error' && (
        <Alert variant="destructive">
          <AlertTitle>System registration</AlertTitle>
          <AlertDescription>
            {banner.detail && <pre className="font-mono text-xs whitespace-pre-wrap break-words">{banner.detail}</pre>}
            {banner.rows.map((row, i) => (
              <pre key={i} className="font-mono text-xs whitespace-pre-wrap break-words">{row}</pre>
            ))}
          </AlertDescription>
          <div className="col-start-2 mt-2">
            <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
              {retrying && <LoaderCircleIcon className="animate-spin" />}
              Retry
            </Button>
          </div>
        </Alert>
      )}
    </section>
  );
}
