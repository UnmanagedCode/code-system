// The backend's wire shapes, as the UI reads them (docs/protocol.md → Backend REST).

export interface ConfigField {
  name: string;
  label: string;
  required?: boolean;
  advanced?: boolean;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface KindDescriptor {
  kind: string;
  label: string;
  configFields: ConfigField[];
  mirrorByDefault: boolean;
}

export interface MirrorDefaults {
  root: string;
  exclude: string[];
}

export interface WorkingRemote {
  remoteId: string;
  kind: string;
  label?: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  storedSecrets?: string[];
  mirror?: unknown;
  baseline?: { state: string; missing?: { capability: string; probe: string; detail: string }[] };
  reachability?: { connected: boolean; detail?: string } | null;
  broken?: undefined;
}

/** A record the store could not read: still listed, with the store's own message. */
export interface BrokenRemote {
  remoteId: string;
  broken: { reason: string; message: string };
}

export type Remote = WorkingRemote | BrokenRemote;

export interface Registration {
  state: string;
  detail?: string | null;
  rows?: { id: string; state: string; message: string }[];
  checkedAt?: string;
}

export interface RemotesResponse {
  remotes: Remote[];
  kinds: KindDescriptor[];
  mirrorDefaults?: MirrorDefaults;
}

/** The mirror as the form holds it: `exclude` is the raw textarea text. */
export interface FormMirror {
  on: boolean;
  root: string;
  exclude: string;
}

/** An open form's values. Separate from the polled data, so a refresh never touches it. */
export interface Draft {
  remoteId: string;
  kind: string;
  label: string;
  config: Record<string, unknown>;
  storedSecrets?: string[];
  clear?: Record<string, boolean>;
  mirror: FormMirror | null;
  advancedOpen: boolean;
}

export type FormMode = 'create' | 'edit';
