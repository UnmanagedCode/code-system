// PINS THE `describeRemote` FRAME for a store-backed kind — the wire half of
// the mirror advertisement, where the PER-REMOTE answer lives.
//
// The CAPABILITY is constant per kind (tests/capabilities.test.mjs); everything
// per remote is here. Driven through the real launcher as a child, against a
// temp store, with the docker CLI pointed at a stub — `describeRemote` never
// touches the transport at all, and the one exec below only has to prove the
// advertisement is inert on that path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher, record, stubDockerCli, tempStore, writeRecord } from './helpers.mjs';

const MIRROR = { root: '/srv/app', exclude: ['/srv/app/tmp', '/proc'] };

const dockerRecord = (id, over = {}) =>
  record(id, { kind: 'docker', config: { container: 'app' }, ...over });

// One launcher, one store, the docker CLI stubbed so nothing here can reach a
// daemon. Returns the stub too, for the exec row.
async function launcher(t, records, { stub = null } = {}) {
  const store = await tempStore();
  t.after(() => store.cleanup());
  for (const r of records) await writeRecord(store.dir, r);
  const cli = stub ?? await stubDockerCli(t);
  const l = new Launcher(['--kind', 'docker'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_DOCKER: JSON.stringify(cli.cli),
  });
  t.after(() => l.kill());
  await l.hello();
  return { l, cli, store };
}

// PINS: what the operator stored is what cc is told — the same root, the same
// entries, IN THE STORED ORDER, and no other field on the frame.
test('describeRemote answers the stored advertisement verbatim', async (t) => {
  const { l } = await launcher(t, [dockerRecord('app', { mirror: MIRROR })]);
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'app' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');

  assert.deepEqual(d, { type: 'remoteDescriptor', id: 'd1', mirrorRoot: MIRROR.root, exclude: MIRROR.exclude });
  assert.deepEqual(d.exclude, MIRROR.exclude, 'in the stored order — the operator typed this list');
});

// PINS THE "UNCHECKED BEHAVES AS BEFORE" HALF, and it is the sharpest row here.
// A remote the operator did not opt in must answer a descriptor with NEITHER
// field — §2.1's valid "I advertise nothing", which cc takes down exactly the
// NO_ADVERTISEMENT path — and specifically NOT an EUNSUPPORTED error frame,
// which is what the capability being false would produce.
test('a remote with no mirror answers an EMPTY descriptor, not EUNSUPPORTED', async (t) => {
  const { l } = await launcher(t, [dockerRecord('plain', { mirror: null })]);
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'plain' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');

  assert.deepEqual(d, { type: 'remoteDescriptor', id: 'd1' },
    'neither mirrorRoot nor exclude — an empty descriptor is a valid answer');
  assert.equal(l.frames.some(f => f.type === 'error'), false,
    'and no error frame: the capability is advertised, so the frame is supported');
});

// PINS THE GATE'S PLACE: `lookup` runs before the frame's own handler for all
// four request frames, so a switched-off remote is an ENOREMOTE naming the
// operator's own action — NOT a descriptor. With `remoteDescriptors` now true,
// an ungated describeRemote would answer a frame, so this row is discriminating
// in a way it could not be while the capability was false.
test('describeRemote for a switched-off remote is an id-addressed ENOREMOTE', async (t) => {
  const { l } = await launcher(t, [dockerRecord('off', { enabled: false, mirror: MIRROR })]);
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'off' });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'd1');

  assert.equal(err.code, 'ENOREMOTE');
  assert.match(err.message, /switched OFF/);
  assert.equal(err.id, 'd1', 'ID-ADDRESSED — an id-less error frame is connection-level');
  assert.equal(l.frames.some(f => f.type === 'remoteDescriptor'), false,
    'and the advertisement of a switched-off remote is never disclosed');
});

test('describeRemote for an unknown remote is an id-addressed ENOREMOTE, and the connection survives', async (t) => {
  const { l } = await launcher(t, [dockerRecord('app', { mirror: MIRROR })]);
  l.send({ type: 'describeRemote', id: 'ghost', remoteId: 'nope' });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'ghost');
  assert.equal(err.code, 'ENOREMOTE');
  assert.equal(err.id, 'ghost');

  // The next frame on the SAME connection is still served.
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'app' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');
  assert.equal(d.mirrorRoot, MIRROR.root);
});

// PINS: THE ADVERTISEMENT IS INERT ON THE EXEC PATH. It is a claim cc consumes
// for path arithmetic on its own side — never argv, never a shell string — so
// no part of it may reach the far-side command line.
test('a mirror changes nothing about the argv an exec runs', async (t) => {
  const stub = await stubDockerCli(t);
  const { l } = await launcher(t, [dockerRecord('app', { mirror: MIRROR })], { stub });
  l.send({ type: 'exec', id: 'e', remoteId: 'app', cwd: '/tmp', argv: ['printf', 'ran'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'e');

  const argv = await stub.argv();
  assert.ok(argv.length > 0, 'the stub really ran');
  assert.equal(argv.some(a => a.includes('/srv/app')), false,
    'the mirror root reaches no argument');
  assert.equal(argv.some(a => a.includes('/proc')), false,
    'and neither does an exclude entry');
});

// PINS: A HAND-EDITED RECORD IS FORWARDED, NEVER LAUNDERED. Only the backend
// writes `mirror`, but the store is a directory of JSON files an operator can
// edit. Coercing a bad shape to the empty advertisement here would turn cc's
// MIRROR_ADVERTISEMENT_INVALID (502) into a silently DIFFERENT, working session
// on the project root — the one failure mode a validator at the front door
// cannot catch, because it never saw this value.
test('an invalid stored mirror reaches cc verbatim, for cc to refuse', async (t) => {
  const { l } = await launcher(t, [
    dockerRecord('wrong-types', { mirror: { root: 123, exclude: 'not-an-array' } }),
    dockerRecord('empty-root', { mirror: { root: '', exclude: ['/proc'] } }),
  ]);

  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'wrong-types' });
  const d1 = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');
  assert.deepEqual(d1, { type: 'remoteDescriptor', id: 'd1', mirrorRoot: 123, exclude: 'not-an-array' },
    'the stored values, unconverted — cc owns the verdict on them');

  // A FALSY-BUT-PRESENT root is the sharp case: it is an INVALID claim, not an
  // absent one, and an emit that spread on truthiness would swallow it into the
  // legal empty descriptor.
  l.send({ type: 'describeRemote', id: 'd2', remoteId: 'empty-root' });
  const d2 = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd2');
  assert.equal(d2.mirrorRoot, '', 'an empty root is on the wire, not dropped');
  assert.deepEqual(d2.exclude, ['/proc']);
});

// PINS THE SAME RULE FOR A NON-OBJECT `mirror`, which is its own input class:
// property access on a primitive yields `undefined`, so a projection that only
// read `.root`/`.exclude` would drop the value entirely and emit the legal empty
// descriptor — the exact laundering the row above exists to prevent, surviving
// in the one shape that has no fields to read. An ARRAY is here too because
// `typeof [] === 'object'` puts it on the object path unless it is excluded
// deliberately.
test('a non-object mirror is forwarded, not silently dropped', async (t) => {
  const cases = [
    ['prim-string', 'oops'],
    ['prim-number', 42],
    ['prim-bool', true],
    ['arr', ['/proc', '/dev']],
  ];
  const { l } = await launcher(t, cases.map(([id, mirror]) => dockerRecord(id, { mirror })));

  for (const [id, mirror] of cases) {
    l.send({ type: 'describeRemote', id: `d-${id}`, remoteId: id });
    const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === `d-${id}`);
    assert.deepEqual(d, { type: 'remoteDescriptor', id: `d-${id}`, mirrorRoot: mirror },
      `${id}: the stored value is on the wire for cc to refuse, not swallowed`);
    // The failure this guards against is indistinguishable from success unless
    // stated: an empty descriptor is what cc reads as a VALID "advertise
    // nothing", so dropping the value runs a working session on the wrong root.
    assert.notDeepEqual(d, { type: 'remoteDescriptor', id: `d-${id}` },
      `${id}: must NOT be the legal empty descriptor`);
  }
});

// PINS THE BOUNDARY THE ROW ABOVE MUST NOT OVERSHOOT: an EMPTY OBJECT is not a
// bad claim. cc's own validateAdvertisement reads `{}` as "advertise nothing" —
// absent, null and `{}` all build the identical advertisement — so forwarding it
// as an empty descriptor is agreement with cc, not laundering.
test('an empty object mirror is the empty descriptor, matching cc\'s own reading', async (t) => {
  const { l } = await launcher(t, [dockerRecord('blank', { mirror: {} })]);
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'blank' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');
  assert.deepEqual(d, { type: 'remoteDescriptor', id: 'd1' });
});

// PINS THE OTHER SIDE OF THAT LINE: an empty exclude LIST really is the same as
// none (§2.1's "advertise nothing"), so it is omitted rather than sent as `[]`.
// Without this, loosening the emit to `!= null` would silently start putting an
// empty array on every unmirrored remote's descriptor.
test('an empty exclude list is omitted, not sent as []', async (t) => {
  const { l } = await launcher(t, [dockerRecord('bare', { mirror: { root: '/srv', exclude: [] } })]);
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'bare' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');
  assert.deepEqual(d, { type: 'remoteDescriptor', id: 'd1', mirrorRoot: '/srv' });
});
