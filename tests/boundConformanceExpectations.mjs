// THE BOUND RUN'S EXPECTATION MANIFEST — one table, two jobs.
//
// A bound `docker` run of cc's battery cannot be all-green, for reasons that are
// OURS AND DELIBERATE, and it also skips the four rows any third-party run
// skips. Rather than two mechanisms (a known-skip count and an expected-failure
// list) that can drift apart, there is one table and one rule:
//
//   ANYTHING NOT LISTED HERE MUST PASS. Anything listed must produce EXACTLY the
//   outcome listed — INCLUDING the verbatim skip reason, and including the fact
//   that it did not pass. A listed row that starts passing is RED, because a
//   manifest that only catches regressions has stopped discriminating.
//
// `cause` is mandatory and structural, and this module THROWS AT IMPORT for an
// entry without a real one — so "expected to fail" can never be added as a bare
// assertion. Each cites the code or the contract clause that makes the outcome
// forced rather than a bug we are tolerating.
//
// EVERY ROW BELOW WAS OBSERVED, not predicted. See
// .wiki/gotchas/bound-conformance.md for the run and its evidence.

export const MIN_CAUSE_CHARS = 60;

const OUTCOMES = new Set(['skip', 'fail']);

// The two reasons a third-party run skips, verbatim from cc's suite at the pin.
// Spelled once each: three of the four skips share the first string, and two
// copies of it would be two things to keep in step.
const CC_SIDE_ONLY =
  'cc-side fixture, pinned to the reference provider: asserts what CC does, not what a provider does';

/** @type {{name:string, outcome:'skip'|'fail', reason?:string, cause:string}[]} */
export const EXPECTED = [
  // ── The four skips, gated on IS_REFERENCE_PROVIDER ────────────────
  // Identical for `host` and for a bound `docker`: the gate is provider
  // IDENTITY, not shape. A fifth skip, or a different reason string, means the
  // harness changed. See .wiki/gotchas/host-kind-and-conformance.md.
  {
    name: 'a provider that does not advertise remotes is never handed a remoteId',
    outcome: 'skip',
    reason: CC_SIDE_ONLY,
    cause: 'cc-side fixture gated on IS_REFERENCE_PROVIDER (referenceProviderHarness.mjs):'
      + ' it uses a provider as a fixture to assert what CC does, and skips for any third-party'
      + ' provider whatever its shape.',
  },
  {
    name: 'a provider without the capability advertises no mirror',
    outcome: 'skip',
    reason: CC_SIDE_ONLY,
    cause: 'cc-side fixture gated on IS_REFERENCE_PROVIDER (referenceProviderHarness.mjs):'
      + ' it pins the ABSENT-behaviour of remoteDescriptors on cc\'s side, not a provider\'s.',
  },
  {
    name: 'CC_CONFORMANCE_REMOTE_ID binds the fixture handle, and an explicit remoteId still wins',
    outcome: 'skip',
    reason: 'asserts the unset default',
    cause: 'the row asserts what an UNSET CC_CONFORMANCE_REMOTE_ID does, which a bound run has'
      + ' deliberately changed; cc skips it for any third-party provider.',
  },
  {
    name: 'every code in the taxonomy is produced by a real failure somewhere in this suite',
    outcome: 'skip',
    reason: 'counts producers across rows a third-party run skips',
    cause: 'the taxonomy census is filled by the rows that RAN, so it is short by exactly the'
      + ' cc-side rows above whatever the provider does; cc skips it for a third-party run.',
  },

  // ── processGroupSignal: a genuine FAILURE, and there is no skip path ──
  // `docker` hardcodes `processGroupSignal: false` (src/launcher/kinds/docker.mjs),
  // a locked, documented decision. CAPABILITY_CONFIGS[0] passes NO flags and
  // requires `true`, and §10's third-party relaxation is explicitly one axis —
  // `remotes`/`remoteDescriptors` may be a superset, every TOGGLED capability
  // must still match — a narrowness the suite pins itself in `the third-party
  // capability assertion tolerates a superset but pins the toggle`. §10 also
  // names our exact shape ("accepts a flag and ignores it") as failing rather
  // than skipping. [processGroupSignal:false] passes both rows, but only
  // because the flag it was given happens to agree with a value we hardcode —
  // NOT because the flag works.
  {
    name: '[all capabilities] the handshake carries the protocol version, the provider name and the capabilities',
    outcome: 'fail',
    cause: 'assertNegotiatedCapabilities loops TOGGLED_CAPABILITIES — which derives to'
      + ' [processGroupSignal] — and CAPABILITY_CONFIGS[0] expects true, while'
      + ' src/launcher/kinds/docker.mjs hardcodes false. systems-protocol.md §10 relaxes only'
      + ' remotes/remoteDescriptors to a superset, so there is no skip path for a truthful false.',
  },
  {
    name: '[all capabilities] process-group signalling: the capability decides whether grandchildren are reachable',
    outcome: 'fail',
    cause: 'the row branches on config.caps.processGroupSignal and, for CAPABILITY_CONFIGS[0],'
      + ' asserts descendantsMaySurvive === undefined; src/launcher/session.mjs correctly sets it'
      + ' true because src/launcher/kinds/docker.mjs advertises processGroupSignal: false.',
  },

  // ── A DEFECT THIS RIG FOUND, not a structural consequence ────────
  //
  // The first thing the bound run measured that the seam argument could not:
  // `host` cannot reach it, because a `host` spawn error fires before any data
  // and cc's collector comment assumes exactly that.
  //
  // MEASURED (2026-09-05, `docker exec` of a missing binary, node:24-slim): the
  // docker CLI writes its whole 151-byte OCI diagnostic to STDOUT, ending
  // `\r\n`, with stderr empty and exit 127. src/launcher/session.mjs streams
  // that stdout to cc as `stdout` frames — it cannot yet know the command never
  // started — and only then does `classifyFailure` recognise the shape and emit
  // the `error` frame. cc's ExecOutputCollector.result fills "whichever buffers
  // are still empty": `stderr` is empty so it gets the spawnError (the row's
  // `r.stderr === r.spawnError` passes), but `output` already holds the streamed
  // 151 bytes, so `r.output === r.spawnError` fails on the untrimmed CRLF text.
  //
  // WHY IT IS LISTED RATHER THAN FIXED HERE: the only fix is to stop streaming
  // the docker CLI's stdout until the exit code can classify it, which trades
  // live streaming — for every command whose output opens with OCI_PREFIX —
  // against this row. That is a transport design decision, and card 2026-0014
  // is scoped to measuring, not to refactoring a provider.
  ...['[all capabilities]', '[processGroupSignal:false]'].map(tag => ({
    name: `${tag} exec NEVER rejects — a command that cannot start is a spawnError, not a throw`,
    outcome: 'fail',
    cause: 'a DEFECT, filed as its own card, not a forced outcome: src/launcher/session.mjs streams the'
      + ' docker CLI\'s own OCI diagnostic to cc as the command\'s stdout before classifyFailure can'
      + ' recognise it (src/launcher/kinds/docker.mjs), so cc\'s ExecOutputCollector.result leaves'
      + ' `output` holding that text instead of the spawnError. Measured: the diagnostic is on STDOUT,'
      + ' 151 bytes ending CRLF, stderr empty, exit 127. Delete this entry when the card lands.',
  })),

  // ── --remote / --mirror / --exclude: structurally unreachable ─────
  // src/launcher/main.mjs refuses these flags for STORE_BACKED kinds with exit 2
  // BEFORE ANY FRAME, so `sys.connect()` fails and §10's "fails that whole
  // configuration at the handshake" applies. Six out-of-loop rows launch their
  // own provider with them. This is not a gap to close: a flag-backed target
  // source on a shipped store-backed kind would be a second remote path around
  // the single ENOREMOTE chokepoint in StoreRemoteSource.lookup.
  ...[
    'a bound handle names its remote on exec, readFile and writeFile',
    'an id is bound to one remote for its whole lifetime — follow-on frames carry none',
    'ENOREMOTE is id-addressed: one dead remote is not a dead connection',
    'a request that names NO remote is refused, never answered from a default',
    'describeRemote round-trips the mirror root and the exclude list',
    'describeRemote for an unknown remote is an id-addressed ENOREMOTE',
  ].map(name => ({
    name,
    outcome: 'fail',
    cause: 'the row launches its own provider with --remote/--mirror/--exclude, and'
      + ' src/launcher/main.mjs refuses those flags for a store-backed kind with exit 2 before any'
      + ' frame, so connect() never handshakes. Deliberate: their targets come from the store, and a'
      + ' flag-backed source would be a second path around StoreRemoteSource.lookup\'s ENOREMOTE gate.',
  })),
];

/**
 * STRUCTURAL, and called at import below: a manifest entry without a real
 * `cause` is the failure mode this table exists to prevent, so it must be
 * impossible to add rather than discouraged.
 * @param {typeof EXPECTED} list
 */
export function validateExpectations(list) {
  if (!Array.isArray(list)) throw new TypeError('the expectation manifest must be an array');
  const seen = new Set();
  for (const [i, e] of list.entries()) {
    const at = `expectation ${i} (${JSON.stringify(e?.name)})`;
    if (!e || typeof e.name !== 'string' || !e.name.trim()) {
      throw new Error(`${at}: needs a verbatim test name`);
    }
    if (seen.has(e.name)) throw new Error(`${at}: listed twice`);
    seen.add(e.name);
    if (!OUTCOMES.has(e.outcome)) {
      throw new Error(`${at}: outcome must be one of ${[...OUTCOMES].join('/')}, got ${JSON.stringify(e.outcome)}`);
    }
    if (e.outcome === 'skip' && (typeof e.reason !== 'string' || !e.reason.trim())) {
      throw new Error(`${at}: a skip entry must carry the VERBATIM reason cc prints,`
        + ' so a different reason string reds instead of passing silently');
    }
    if (e.outcome === 'fail' && e.reason !== undefined) {
      throw new Error(`${at}: a fail entry has no printed reason to pin`);
    }
    if (typeof e.cause !== 'string' || e.cause.trim().length < MIN_CAUSE_CHARS) {
      throw new Error(`${at}: needs a \`cause\` of at least ${MIN_CAUSE_CHARS} characters naming the`
        + ' code or contract clause that FORCES this outcome. A bare "expected to fail" is exactly'
        + ' what this manifest exists to stop.');
    }
  }
  return list;
}

validateExpectations(EXPECTED);

/**
 * The comparison, in both directions.
 *
 * @param {Map<string,{outcome:'pass'|'fail'|'skip', reason:string|null}>} observed
 * @param {typeof EXPECTED} expected
 * @returns {{kind:string, name:string, message:string}[]} empty when the run matched
 */
export function compareOutcomes(observed, expected = EXPECTED) {
  const problems = [];
  const listed = new Map(expected.map(e => [e.name, e]));

  for (const e of expected) {
    const got = observed.get(e.name);
    if (!got) {
      problems.push({
        kind: 'row-missing', name: e.name,
        message: 'the harness moved — this row is in the manifest but the run never reported it.'
          + ' Re-read its cause against the current suite before deleting the entry.',
      });
      continue;
    }
    if (got.outcome === 'pass') {
      problems.push({
        kind: 'unexpected-pass', name: e.name,
        message: `the harness moved — this row now passes; delete its entry and re-read its cause: ${e.cause}`,
      });
      continue;
    }
    if (got.outcome !== e.outcome) {
      problems.push({
        kind: 'outcome-changed', name: e.name,
        message: `expected ${e.outcome}, observed ${got.outcome}`
          + (got.reason ? ` (${got.reason})` : ''),
      });
      continue;
    }
    if (e.outcome === 'skip' && got.reason !== e.reason) {
      problems.push({
        kind: 'reason-changed', name: e.name,
        message: `a known skip with a DIFFERENT reason string — the harness changed.\n`
          + `      expected: ${JSON.stringify(e.reason)}\n`
          + `      observed: ${JSON.stringify(got.reason)}`,
      });
    }
  }

  for (const [name, got] of observed) {
    if (listed.has(name) || got.outcome === 'pass') continue;
    problems.push({
      kind: got.outcome === 'skip' ? 'unexpected-skip' : 'unexpected-fail',
      name,
      message: got.outcome === 'skip'
        ? `an UNLISTED skip: ${JSON.stringify(got.reason)}`
        : 'an UNLISTED failure — the shipped docker transport did not satisfy this row',
    });
  }

  return problems;
}
