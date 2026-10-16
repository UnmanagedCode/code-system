import type { ReactNode } from 'react';
import { ChevronRightIcon, LoaderCircleIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { HintTip } from '@/components/HintTip';
import { advancedSummary, fieldLabel, switchKind } from '@/lib/cardState.mjs';
import type { ConfigField, Draft, FormMirror, FormMode, KindDescriptor, MirrorDefaults } from '@/lib/types';

const REMOTE_ID_HINT = 'Lower-case letters, digits, dot, dash, underscore. This is what goes in a project\'s'
  + ' Remote field, and it can never be renamed.';
const MIRROR_ON_HINT = 'code-conductor asks for the mirror once per provider connection, so a change to these'
  + ' three fields reaches an already-running session only after the System reconnects.'
  + ' Changing them does not switch this remote off.';
const MIRROR_ROOT_HINT = 'code-conductor\'s session root becomes the image of this path, so a worker can read and'
  + ' edit anywhere under it. / is the whole target.';
const MIRROR_EXCLUDE_HINT = 'One absolute path per line, in normal form. These are never carried across — the defaults'
  + ' are the target\'s pseudo-filesystems.';
const EDIT_NOTE_HINT = 'Including a password, a key file or Run as: a different config may point at a different'
  + ' target, or run as a different user. Saving with every value unchanged, or editing only'
  + ' the label or the mirror settings, does not.';

/** A label row: the label, and its "?" when the field has an explanation. The row anchors the tip. */
function FieldHead({ inputId, label, hint }: { inputId: string; label: string; hint?: string }) {
  return (
    <div className="relative flex items-center gap-1.5">
      <Label htmlFor={inputId} className="text-xs text-muted-foreground">{label}</Label>
      {hint && <HintTip id={`${inputId}-tip`} name={label} text={hint} />}
    </div>
  );
}

function Field({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">{children}</div>;
}

/**
 * ONE RENDERER FOR BOTH create (a trailing tile) and edit (inside its own card). The config fields
 * come from the kind's own descriptor, so the form can never offer a field the store would reject or
 * hide one the kind requires. Every decision is in lib/cardState.mjs; this is wiring.
 */
export function RemoteForm({ mode, draft, kinds, mirrorDefaults, submitting, error, onChange, onSubmit, onCancel }: {
  mode: FormMode;
  draft: Draft;
  kinds: KindDescriptor[];
  mirrorDefaults: MirrorDefaults | null;
  submitting: boolean;
  /** The last Create/Save refusal, shown in the form rather than in the page's notices. */
  error: string | null;
  onChange: (next: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const descriptor = kinds.find((k) => k.kind === draft.kind) ?? null;
  const fields = descriptor?.configFields ?? [];
  const advancedFields = fields.filter((f) => f.advanced === true);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setConfig = (name: string, value: string) => set({ config: { ...draft.config, [name]: value } });
  const m = draft.mirror;
  const setMirror = (patch: Partial<FormMirror>) => { if (m) set({ mirror: { ...m, ...patch } }); };

  // A SECRET field is a password input, never prefilled (the API never returns its value, and the
  // edit draft drops it). When one is stored, the form says so and offers to clear it: blank keeps
  // it, the checkbox removes it.
  const configField = (f: ConfigField) => {
    const id = `f-${f.name}`;
    const secret = f.secret === true;
    const stored = secret && mode === 'edit' && (draft.storedSecrets ?? []).includes(f.name);
    const label = fieldLabel(f);
    return (
      <Field key={f.name}>
        <FieldHead inputId={id} label={label} hint={f.hint} />
        <Input
          id={id}
          className="font-mono"
          aria-describedby={f.hint ? `${id}-tip` : undefined}
          value={String(draft.config[f.name] ?? '')}
          placeholder={stored ? 'stored — leave blank to keep' : (f.placeholder ?? '')}
          {...(secret ? { type: 'password', autoComplete: 'new-password' } : {})}
          onChange={(e) => setConfig(f.name, e.target.value)}
        />
        {stored && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-clear`}
              checked={draft.clear?.[f.name] === true}
              onCheckedChange={(c) => set({ clear: { ...draft.clear, [f.name]: c === true } })}
            />
            <Label htmlFor={`${id}-clear`} className="text-xs font-normal">Clear stored {f.label.toLowerCase()}</Label>
          </div>
        )}
      </Field>
    );
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); if (!submitting) onSubmit(); }}
    >
      {mode === 'create' && (
        <>
          <Field>
            <FieldHead inputId="f-id" label="Remote id" hint={REMOTE_ID_HINT} />
            <Input
              id="f-id"
              className="font-mono"
              autoFocus
              value={draft.remoteId}
              placeholder="app-ctr"
              aria-describedby="f-id-tip"
              onChange={(e) => set({ remoteId: e.target.value })}
            />
          </Field>
          <Field>
            <FieldHead inputId="f-kind" label="Kind" />
            <NativeSelect
              id="f-kind"
              className="w-full"
              value={draft.kind}
              onChange={(e) => {
                const next = kinds.find((k) => k.kind === e.target.value);
                if (next) onChange(switchKind(draft, next, mirrorDefaults));
              }}
            >
              {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </NativeSelect>
          </Field>
        </>
      )}

      <Field>
        <FieldHead inputId="f-label" label="Label" />
        <Input
          id="f-label"
          autoFocus={mode === 'edit'}
          value={draft.label}
          placeholder={draft.remoteId || 'optional'}
          onChange={(e) => set({ label: e.target.value })}
        />
      </Field>

      {fields.filter((f) => f.advanced !== true).map(configField)}

      {/* A CHANGED CONFIG VALUE SWITCHES THE REMOTE OFF, and the form says so up front. Scoped to the
          config fields wherever they render: an advanced config field (Run as) resets the gate too,
          the mirror does not. */}
      {mode === 'edit' && (
        <div className="relative flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Changing a connection value switches this remote off.</span>
          <HintTip id="f-note-tip" name="changing a connection value" text={EDIT_NOTE_HINT} />
        </div>
      )}

      {/* THE ADVANCED GROUP. Its open state is the operator's (`draft.advancedOpen`, written on toggle),
          never derived from the mirror checkbox, which would collapse it under the cursor. The summary
          states the mirror, so a collapsed group still says what will be advertised. The mirror half
          waits for the served defaults; the group does not, because an advanced config field has
          nothing to prefill from. */}
      {(m || advancedFields.length > 0) && (
        <details
          className="group border-t pt-3"
          open={draft.advancedOpen}
          onToggle={(e) => {
            const open = e.currentTarget.open;
            if (open !== draft.advancedOpen) set({ advancedOpen: open });
          }}
        >
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
            Advanced
            <span data-slot="summary-state" className="font-mono">{advancedSummary(m).slice('Advanced'.length)}</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {advancedFields.map(configField)}
            {m && (
              <>
                <div className="relative flex items-center gap-2">
                  <Checkbox
                    id="f-mirror-on"
                    checked={m.on}
                    aria-describedby="f-mirror-on-tip"
                    onCheckedChange={(c) => setMirror({ on: c === true })}
                  />
                  <Label htmlFor="f-mirror-on" className="text-sm font-normal">Advertise a mirror root to code-conductor</Label>
                  <HintTip id="f-mirror-on-tip" name="the mirror root" text={MIRROR_ON_HINT} />
                </div>
                <Field>
                  <FieldHead inputId="f-mirror-root" label="Mirror root" hint={MIRROR_ROOT_HINT} />
                  <Input
                    id="f-mirror-root"
                    className="font-mono"
                    value={m.root}
                    placeholder="/"
                    disabled={!m.on}
                    aria-describedby="f-mirror-root-tip"
                    onChange={(e) => setMirror({ root: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldHead inputId="f-mirror-exclude" label="Excluded paths" hint={MIRROR_EXCLUDE_HINT} />
                  <Textarea
                    id="f-mirror-exclude"
                    className="font-mono"
                    rows={3}
                    value={m.exclude}
                    disabled={!m.on}
                    aria-describedby="f-mirror-exclude-tip"
                    onChange={(e) => setMirror({ exclude: e.target.value })}
                  />
                </Field>
              </>
            )}
          </div>
        </details>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap break-words">{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={submitting} onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <LoaderCircleIcon className="animate-spin" />}
          {mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
