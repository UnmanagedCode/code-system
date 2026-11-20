// THE agent BOUND RUN'S MANIFEST (tests/conformance-agent.mjs): every row of
// cc's conformance suite that does not pass against `--kind agent`, with the
// cause that FORCES it. FILLED FROM A MEASURED RUN, never by analogy with
// docker's manifest: each name, skip reason and failing assertion below was
// read off the agent run's own output, identical on both channel arms. Same
// rules, same checker (boundConformanceExpectations.mjs `validateExpectations`):
// a verbatim name, a skip's verbatim reason, and a cause citing the code or the
// spec section behind it.

import { validateExpectations } from './boundConformanceExpectations.mjs';

// The battery's size at the pin this manifest was measured against.
export const EXPECTED_AGENT_TOTAL = 93;

const CC_SIDE_ONLY =
  'cc-side fixture, pinned to the reference provider: asserts what CC does, not what a provider does';

const FLAG_ROWS = [
  'a bound handle names its remote on exec, readFile and writeFile',
  'an id is bound to one remote for its whole lifetime — follow-on frames carry none',
  'ENOREMOTE is id-addressed: one dead remote is not a dead connection',
  'a request that names NO remote is refused, never answered from a default',
  'describeRemote round-trips the mirror root and the exclude list',
  'describeRemote for an unknown remote is an id-addressed ENOREMOTE',
  'listRemotes enumerates exactly the configured targets; an unconfigured id refuses ENOREMOTE',
  'listRemotes is one id among many: answered beside an in-flight exec, never disturbing it',
  'bound views share their provider\'s terminal cap, and each terminal runs on its own remote',
];

/** @type {{name:string, outcome:'skip'|'fail', reason?:string, cause:string}[]} */
export const EXPECTED_AGENT = [
  // ── cc-side and reference-only rows: skipped for any third-party provider ──
  {
    name: 'a provider that does not advertise remotes is never handed a remoteId',
    outcome: 'skip',
    reason: CC_SIDE_ONLY,
    cause: 'cc-side fixture gated on IS_REFERENCE_PROVIDER (referenceProviderHarness.mjs): it uses a'
      + ' provider to assert what CC does, and skips for any third-party provider whatever its shape.',
  },
  {
    name: 'a provider without the capability advertises no mirror',
    outcome: 'skip',
    reason: CC_SIDE_ONLY,
    cause: 'cc-side fixture gated on IS_REFERENCE_PROVIDER (referenceProviderHarness.mjs): it pins the'
      + ' ABSENT-behaviour of remoteDescriptors on cc\'s side, not a provider\'s.',
  },
  {
    name: 'a provider without remoteListing refuses listRemotes EUNSUPPORTED, id-addressed',
    outcome: 'skip',
    reason: 'a provider that does not advertise a capability may ignore its frame (§2); the reference provider refuses it',
    cause: 'reference-only (systems-protocol.md §2): src/launcher/kinds/agent.mjs always advertises'
      + ' remoteListing, so this provider has no absent-behaviour for the row to observe.',
  },
  {
    name: 'CC_CONFORMANCE_REMOTE_ID binds the fixture handle, and an explicit remoteId still wins',
    outcome: 'skip',
    reason: 'asserts the unset default',
    cause: 'the row asserts what an UNSET CC_CONFORMANCE_REMOTE_ID does, which tests/conformance-agent.mjs'
      + ' sets on purpose to bind the battery to its agent remote.',
  },
  {
    name: 'every code in the taxonomy is produced by a real failure somewhere in this suite',
    outcome: 'skip',
    reason: 'counts producers across rows a third-party run skips',
    cause: 'the taxonomy census counts producers across the rows that RAN, so it is short by the cc-side'
      + ' rows above for any third-party provider; systems-protocol-conformance.test.mjs skips it.',
  },

  // ── processGroupSignal: false, decided (plan decision 8) ──
  {
    name: '[all capabilities] the handshake carries the protocol version, the provider name and the capabilities',
    outcome: 'fail',
    cause: 'measured: "processGroupSignal: the flag the provider was launched with is what it advertises,'
      + ' false !== true". src/launcher/kinds/agent.mjs advertises processGroupSignal: false, final: a'
      + ' signal sent to a bridge reaches only the bridge, never the far group (systems-protocol.md §11).',
  },
  {
    name: '[all capabilities] process-group signalling: the capability decides whether grandchildren are reachable',
    outcome: 'fail',
    cause: 'measured: "with group reach the result claims nothing was left behind" got true. The row'
      + ' expects processGroupSignal: true; src/launcher/session.mjs sets descendantsMaySurvive because'
      + ' src/launcher/kinds/agent.mjs advertises false.',
  },
  {
    name: '[processGroupSignal:false, pty:false] detach ends the operation and kills nothing; close kills as far as it reaches',
    outcome: 'fail',
    cause: 'measured: "without group reach close cannot get to it either, false !== true". close runs'
      + ' the kind\'s reap (src/launcher/session.mjs #close), and src/launcher/kinds/reapscript.mjs scans'
      + ' the whole far subtree by CC_EXEC_TOKEN, so close reaches further than a signal can — the same'
      + ' forced trade the docker manifest records for a provider advertising processGroupSignal: false.',
  },

  // ── a defect shared with --kind host and docker ──
  ...['[all capabilities]', '[processGroupSignal:false, pty:false]'].map(tag => ({
    name: `${tag} a path that cannot resolve is ENAMETOOLONG or ELOOP, on the derived and the frame path`,
    outcome: 'fail',
    cause: 'measured: "readFile of an over-long name: expected ENAMETOOLONG, got ENOENT". A DEFECT in'
      + ' src/launcher/fileops.mjs, not this transport: its readFile script refuses [ ! -e "$p" ] as'
      + ' ENOENT, which test(1) cannot tell from a too-long or looping name (systems-protocol.md §8).'
      + ' Observed identically on --kind host. Delete when fixed.',
  })),

  // ── the far parent is the agent ──
  {
    name: '[all capabilities] the env overlay reaches the program and never the helper',
    outcome: 'fail',
    cause: 'measured: the row\'s PRECONDITION "the program\'s parent is the pty helper" read'
      + ' /proc/<$PPID>/cmdline and found agent/agent.py. The program runs on the far side, whose'
      + ' parent is the agent (src/launcher/kinds/agent.mjs ptyMode \'exec\'); cc\'s helper runs the'
      + ' bridge on this side. The property itself holds: tests/ptyscript.test.mjs pins it.',
  },

  // ── the launch flags a store-backed kind refuses ──
  ...FLAG_ROWS.map(name => ({
    name,
    outcome: 'fail',
    cause: 'measured: "provider exited (code 2)" before any frame. The row launches its own provider with'
      + ' --remote/--mirror/--exclude, which src/launcher/main.mjs refuses for a store-backed kind'
      + ' (agent, like docker and ssh): its targets come from the store, and a flag-backed source would'
      + ' be a second path around StoreRemoteSource.lookup\'s gate.',
  })),
];

validateExpectations(EXPECTED_AGENT);
