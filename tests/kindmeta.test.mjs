// PINS THE KIND SEAM'S TWO NEW OBLIGATIONS, both of which exist so that adding
// a kind cannot ship something half-wired:
//
//  1. every registered kind implements `connect`/`disconnect`, because those are
//     the OPERATOR GATE's per-kind side effect and not a multiplexing feature —
//     a kind with nothing to open still has to say so;
//  2. every registered kind has a KIND_META, so the card UI can render a form
//     for it, and that form's fields cannot drift from what `validateConfig`
//     actually accepts.
//
// `KIND_META` is also the SINGLE SOURCE OF TRUTH for a kind's human label: the
// cc System row's label and the card's kind badge both read it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTERED_KINDS, createTransport, kindDescriptors,
} from '../src/launcher/kinds/index.mjs';
import { stubDockerCli } from './helpers.mjs';

// A plausible value per descriptor field, so a form can be filled in from the
// descriptor alone. Never option-shaped — a leading `-` is refused by design.
const SAMPLE = { container: 'app', host: 'box', user: 'me' };

// PINS: the gate's per-kind seam is REQUIRED, not optional. Before the gate,
// `connect`/`disconnect` were an ssh-only multiplexing detail and `docker` had
// neither. A kind missing them now means a Connect button that silently does
// nothing on one kind and works on another.
test('every registered kind implements connect and disconnect', () => {
  for (const kind of REGISTERED_KINDS) {
    const t = createTransport(kind);
    assert.equal(typeof t.connect, 'function', `${kind}.connect`);
    assert.equal(typeof t.disconnect, 'function', `${kind}.disconnect`);
  }
});

// PINS ATTACH-ONLY AT THE GATE, in its strongest available form. `docker
// connect` must be a PASS that only moves the gate — the counting stub records
// ZERO invocations, so this fails for `docker start` and equally for a `docker
// inspect` someone adds "just to check first". Anything else would also have to
// get past assertAttachOnly.
test('docker connect and disconnect invoke docker ZERO times', async (t) => {
  const stub = await stubDockerCli(t, { stdout: 'true img 2026-09-01T00:00:00Z\n' });
  const transport = createTransport('docker', {});
  // The stub is injected the way every other docker test does it, so this runs
  // the real factory rather than a hand-built object.
  const d = (await import('../src/launcher/kinds/docker.mjs')).createDockerTransport({ cli: stub.cli });

  await d.connect({ container: 'app' });
  await d.disconnect({ container: 'app' });

  assert.deepEqual(await stub.argv(), [],
    'connecting a docker remote must not start, stop, or even inspect a container');
  assert.equal(typeof transport.connect, 'function');
});

// PINS: `connect` answers an object the route can carry, and `disconnect`
// resolves rather than throwing — the backend's disconnect route must never be
// blockable, and a kind that threw "nothing to close" would block it.
test('docker connect resolves with a detail object, and disconnect never throws', async (t) => {
  const stub = await stubDockerCli(t);
  const d = (await import('../src/launcher/kinds/docker.mjs')).createDockerTransport({ cli: stub.cli });
  const res = await d.connect({ container: 'app' });
  assert.equal(typeof res, 'object');
  assert.notEqual(res, null);
  await d.disconnect({ container: 'app' });
});

// PINS: a registered kind with no KIND_META is a HARD FAILURE, not a card with
// an empty form. Driven through the parameter rather than by perturbing the
// registry: `host` is a real kind that deliberately has no meta, because it is
// never registered and never gets a card.
test('kindDescriptors throws for a kind with no KIND_META', () => {
  assert.throws(() => kindDescriptors(['host']), /host/,
    'adding a kind must not be able to ship a form-less card');
  // The production set is complete, which is the same guard from the other side.
  assert.doesNotThrow(() => kindDescriptors());
});

// PINS THE DESCRIPTOR ↔ VALIDATOR CONTRACT. The card's form is generated from
// `configFields`; `validateConfig` is what actually accepts a config. If they
// drift, the form either offers a field the store will reject or hides one the
// kind requires — and both fail only in a browser, where no test looks.
test('every descriptor\'s fields are exactly what its validateConfig accepts', () => {
  const descriptors = kindDescriptors();
  assert.deepEqual(descriptors.map(d => d.kind), [...REGISTERED_KINDS],
    'one descriptor per registered kind, in the registry\'s own order');

  for (const d of descriptors) {
    assert.ok(d.label, `${d.kind}: a human label`);
    assert.ok(d.configFields.length > 0, `${d.kind}: at least one field`);

    const validate = createTransport(d.kind).validateConfig.bind(createTransport(d.kind));
    const full = Object.fromEntries(d.configFields.map(f => [f.name, SAMPLE[f.name]]));
    for (const f of d.configFields) {
      assert.ok(SAMPLE[f.name] !== undefined,
        `${d.kind}.${f.name}: this test needs a sample value for every field`);
      assert.ok(f.label, `${d.kind}.${f.name}: a label`);
    }

    const v = validate(full);
    assert.equal(v.ok, true, `${d.kind}: a config built from the descriptor alone is accepted`);
    assert.deepEqual(Object.keys(v.config).sort(), d.configFields.map(f => f.name).sort(),
      `${d.kind}: the accepted config is exactly the descriptor's fields — no hidden field, no dead one`);

    // Each `required: true` must REALLY be required, and each optional one
    // really optional. A form that marks the wrong field either blocks a valid
    // remote or lets an invalid one reach the store's front door.
    for (const f of d.configFields) {
      const without = { ...full };
      delete without[f.name];
      assert.equal(validate(without).ok, !f.required,
        `${d.kind}.${f.name}: required=${f.required} does not match validateConfig`);
    }
  }
});

// PINS THAT `advanced` CHANGES RENDERING ONLY. It is a hint to the card form
// about WHERE to draw a field, not a second, weaker class of field: an advanced
// field is validated, stored and reset-on-change exactly like a connection one.
// A mutant that let the descriptor carry a flagged field the validator does not
// accept would ship a form whose Advanced group cannot be saved.
test('an advanced config field is still a real config field', () => {
  const flagged = kindDescriptors().flatMap(d => d.configFields
    .filter(f => f.advanced === true).map(f => ({ kind: d.kind, field: f })));
  assert.ok(flagged.length > 0, 'this test needs at least one advanced field to be about');

  for (const { kind, field } of flagged) {
    assert.equal(field.advanced, true);
    const validate = createTransport(kind).validateConfig.bind(createTransport(kind));
    const full = Object.fromEntries(
      kindDescriptors().find(d => d.kind === kind).configFields.map(f => [f.name, SAMPLE[f.name]]));
    const v = validate(full);
    assert.equal(v.ok, true, `${kind}.${field.name}: ${v.error}`);
    assert.equal(v.config[field.name], SAMPLE[field.name],
      `${kind}.${field.name}: an advanced field is stored like any other`);
  }
});
