import { useEffect, useId, useState } from 'react';
import { PlusIcon, RefreshCwIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AppHeader } from '@/components/AppHeader';
import { DeleteDialog } from '@/components/DeleteDialog';
import { RegistrationPanel, type Notice } from '@/components/RegistrationPanel';
import { BrokenCard, RemoteCard, type CardAction } from '@/components/RemoteCard';
import { RemoteForm } from '@/components/RemoteForm';
import { api, json } from '@/lib/api';
import {
  NEW_KEY, REG_KEY, createDraft, editDraft, remotePath, routeFromSearch, searchForRoute, submitRequest,
} from '@/lib/cardState.mjs';
import { useRemotes } from '@/lib/useRemotes';
import type { Draft, FormMode, WorkingRemote } from '@/lib/types';

type Route = ReturnType<typeof routeFromSearch>;
type Busy = ReadonlyMap<string, CardAction | 'retry'>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The page. It owns the route, the open form's draft, the notices and what is busy; the polled data
 * lives in `useRemotes`. NO OPTIMISTIC UPDATES: a card is disabled while its action runs and its new
 * state comes back from the server — a gate reading "Enabled" before the write landed would be
 * exactly the lie this card is built to avoid.
 */
export function App() {
  const data = useRemotes();
  // The route is READ on load but opens no form: a form needs a draft, and only Add and Edit make one.
  const [route, setRoute] = useState<Route>(() => routeFromSearch(location.search));
  const [draft, setDraft] = useState<Draft | null>(null);
  // A new draft remounts its form: autofocus, the tips' state and the in-form error start fresh.
  const [draftGen, setDraftGen] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<Busy>(new Map());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const addTitleId = useId();

  // `history.replaceState`, never pushState and never the hash: cc's bridge demotes pushState anyway,
  // and a hash change adds a history entry Back would step through. Query string only, so the
  // document stays at the plugin root and relative URLs keep resolving.
  const go = (next: Route, nextDraft: Draft | null) => {
    setRoute(next);
    setDraft(nextDraft);
    setFormError(null);
    if (nextDraft) setDraftGen((g) => g + 1);
    history.replaceState(null, '', `${location.pathname}${searchForRoute(next)}`);
  };

  // cc's own navigation arrives as a synthetic popstate. It reads the route and drops any draft.
  useEffect(() => {
    const onPop = () => {
      setRoute(routeFromSearch(location.search));
      setDraft(null);
      setFormError(null);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const descriptorFor = (kind: string) => data.kinds.find((k) => k.kind === kind) ?? null;

  const markBusy = (key: string, action: CardAction | 'retry' | null) => setBusy((b) => {
    const next = new Map(b);
    if (action) next.set(key, action); else next.delete(key);
    return next;
  });

  const runAction = async (key: string, action: CardAction | 'retry', run: () => Promise<void>) => {
    markBusy(key, action);
    try { await run(); } catch (e) { setNotice({ level: 'err', text: message(e) }); } finally {
      markBusy(key, null);
      await data.refresh();
    }
  };

  // A gate route's response carries more than its status: disconnect answers 200 with a `warning`
  // when the transport could not close its channel, and the refresh after it carries no warning.
  const gateAction = (id: string, verb: 'connect' | 'disconnect') => runAction(id, verb, async () => {
    const res = await api<{ warning?: string }>(remotePath(id, verb), json('POST'));
    if (res.warning) setNotice({ level: 'warn', text: res.warning });
  });

  // The delete warning names the cc projects that still use this id: nothing else would tell the
  // operator which projects they just stranded.
  const deleteRemote = (id: string) => runAction(id, 'delete', async () => {
    const res = await api<{ warning?: string }>(remotePath(id), json('DELETE'));
    if (res.warning) setNotice({ level: 'warn', text: res.warning });
  });

  // A refused Create/Save is shown IN THE FORM, which stays open with what was typed.
  const submitForm = async (mode: FormMode) => {
    if (!draft) return;
    const key = mode === 'create' ? NEW_KEY : draft.remoteId;
    const req = submitRequest(mode, draft, descriptorFor(draft.kind));
    setFormError(null);
    markBusy(key, 'submit');
    try {
      await api(req.path, json(req.method, req.body));
      go({ view: 'list' }, null);
    } catch (e) {
      setFormError(message(e));
    } finally {
      markBusy(key, null);
      await data.refresh();
    }
  };

  const form = (mode: FormMode) => draft && (
    <RemoteForm
      key={draftGen}
      mode={mode}
      draft={draft}
      kinds={data.kinds}
      mirrorDefaults={data.mirrorDefaults}
      submitting={busy.has(mode === 'create' ? NEW_KEY : draft.remoteId)}
      error={formError}
      onChange={setDraft}
      onSubmit={() => void submitForm(mode)}
      onCancel={() => go({ view: 'list' }, null)}
    />
  );

  const adding = route.view === 'add' && draft !== null;
  const editing = (r: WorkingRemote) => route.view === 'edit' && route.remoteId === r.remoteId && draft !== null;
  const cardBusy = (id: string) => {
    const b = busy.get(id);
    return b === 'retry' ? undefined : b;
  };

  return (
    <div className="min-h-full">
      <AppHeader registration={data.registration} />
      <main className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 pt-3 pb-16">
        <RegistrationPanel
          notice={notice}
          onDismiss={() => setNotice(null)}
          registration={data.registration}
          retrying={busy.has(REG_KEY)}
          onRetry={() => void runAction(REG_KEY, 'retry', async () => { await api('api/registration/retry', json('POST')); })}
        />

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => go({ view: 'add' }, createDraft(data.kinds, data.mirrorDefaults))}>
            <PlusIcon />
            Add remote
          </Button>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {data.updatedAt && `updated ${data.updatedAt.toLocaleTimeString()}`}
          </span>
          <Button type="button" variant="ghost" size="icon" aria-label="Refresh" onClick={() => void data.refresh()}>
            <RefreshCwIcon />
          </Button>
        </div>

        {data.loadError && (
          <Alert variant="destructive">
            <AlertDescription className="break-words">Backend unreachable: {data.loadError}</AlertDescription>
            <div className="col-start-2 mt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void data.refresh()}>Retry</Button>
            </div>
          </Alert>
        )}

        {!data.loaded && !data.loadError && (
          <div role="status" className="flex flex-col gap-3">
            <p className="text-center text-sm text-muted-foreground">Loading remotes…</p>
            <div aria-hidden className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
            </div>
          </div>
        )}

        {data.loaded && data.remotes.length === 0 && !adding && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No remotes yet. Add a Docker container or an SSH host to get started.
          </p>
        )}

        {(data.remotes.length > 0 || adding) && (
          <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.remotes.map((r) => (r.broken
              ? <BrokenCard key={r.remoteId} remote={r} busy={cardBusy(r.remoteId)} onDelete={() => setPendingDelete(r.remoteId)} />
              : (
                <RemoteCard
                  key={r.remoteId}
                  remote={r}
                  descriptor={descriptorFor(r.kind)}
                  busy={cardBusy(r.remoteId)}
                  onGate={(verb) => void gateAction(r.remoteId, verb)}
                  onEdit={() => go({ view: 'edit', remoteId: r.remoteId }, editDraft(r, descriptorFor(r.kind), data.mirrorDefaults))}
                  onDelete={() => setPendingDelete(r.remoteId)}
                >
                  {editing(r) && form('edit')}
                </RemoteCard>
              )))}
            {adding && (
              <Card role="region" aria-labelledby={addTitleId} className="gap-3 border-l-[6px] border-l-muted-foreground px-4 py-3">
                <h2 id={addTitleId} className="font-semibold">New remote</h2>
                {form('create')}
              </Card>
            )}
          </div>
        )}
      </main>

      <DeleteDialog
        remoteId={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={(id) => { setPendingDelete(null); void deleteRemote(id); }}
      />
    </div>
  );
}
