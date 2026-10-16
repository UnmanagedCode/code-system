import { Badge } from '@/components/ui/badge';
import { registrationView } from '@/lib/cardState.mjs';
import type { Registration } from '@/lib/types';

const PILL = { ok: 'success', neutral: 'outline', bad: 'destructive' } as const;

export function AppHeader({ registration }: { registration: Registration | null }) {
  const view = registrationView(registration);
  return (
    <header className="sticky top-0 z-10 border-b bg-card pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Code System</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Docker containers and SSH hosts, reached from code-conductor's own machine.
          </p>
        </div>
        {view && (
          <Badge
            variant={PILL[view.pill.tone]}
            data-slot="registration-pill"
            className={`font-mono ${view.pill.tone === 'neutral' ? 'text-muted-foreground' : ''}`}
          >
            {view.pill.text}
          </Badge>
        )}
      </div>
    </header>
  );
}
