import test from 'node:test';
import assert from 'node:assert/strict';
import { providerCanRun, providerIsVerifiedReady, providerOptionSuffix, providerConnectionStatus, providerAvailabilitySource, providerSnapshotKey, createProviderStatusPoller } from '../public/provider-availability.mjs';

const connected = availability => ({ id: 'codex', installed: true, authenticated: true, canRun: true, availability });

test('unknown usage permits retry but never claims verified capacity', () => {
  const provider = connected({ status: 'unknown', canRun: true });
  assert.equal(providerCanRun(provider), true);
  assert.equal(providerIsVerifiedReady(provider), false);
  assert.match(providerConnectionStatus(provider), /unknown.*retry allowed/);
  assert.equal(providerCanRun({ ...provider, authenticated: false }), false);
  assert.equal(providerCanRun({ ...provider, installed: false }), false);
  assert.equal(providerCanRun({ ...provider, canRun: false }), false);
});

test('model-specific limits are advisory rather than a provider-wide lock', () => {
  const provider = connected({ status: 'limited', canRun: true, source: 'account-rate-limits' });
  assert.equal(providerCanRun(provider), true);
  assert.equal(providerIsVerifiedReady(provider), false);
  assert.match(providerOptionSuffix(provider), /some usage limited/);
  assert.match(providerConnectionStatus(provider), /retry allowed/);
});

test('metadata capacity does not claim that a live AI request was run', () => {
  const provider = connected({ status: 'available', canRun: true, source: 'account-rate-limits' });
  assert.equal(providerIsVerifiedReady(provider), true);
  assert.match(providerConnectionStatus(provider), /account reports capacity/);
  assert.match(providerAvailabilitySource(provider), /No AI prompt/);
  assert.doesNotMatch(providerConnectionStatus(provider), /request succeeded|live use verified/);
  assert.match(providerConnectionStatus(connected({ status: 'available', source: 'last-run' })), /recent request succeeded/);
});

test('timestamp-only updates do not rebuild composer model controls', () => {
  const first = [connected({ status: 'available', checkedAt: '2026-10-14T01:00:00Z' })];
  const second = [connected({ status: 'available', checkedAt: '2026-10-14T01:01:00Z' })];
  assert.equal(providerSnapshotKey(first), providerSnapshotKey(second));
  second[0].availability.status = 'unknown';
  assert.notEqual(providerSnapshotKey(first), providerSnapshotKey(second));
});

test('passive polling is bounded, non-overlapping, and skips hidden windows', async () => {
  let time = 0, visible = false, reads = 0, resolve;
  const applied = [];
  const poller = createProviderStatusPoller({ now: () => time, visible: () => visible,
    read: () => { reads++; return new Promise(done => { resolve = done; }); }, apply: value => applied.push(value) });
  await poller.poll(); assert.equal(reads, 0);
  visible = true;
  const first = poller.poll(), duplicate = poller.poll();
  assert.equal(first, duplicate);
  await Promise.resolve(); assert.equal(reads, 1);
  resolve(['current']); await first;
  await poller.poll(); assert.equal(reads, 1);
  time = 60_000;
  const next = poller.poll(); await Promise.resolve(); resolve(['recovered']); await next;
  assert.deepEqual(applied, [['current'], ['recovered']]);
});

test('an older poll cannot overwrite a manual refresh or a newly finished run', async () => {
  let resolve;
  const applied = [];
  const poller = createProviderStatusPoller({ read: () => new Promise(done => { resolve = done; }), apply: value => applied.push(value) });
  const pending = poller.poll(); await Promise.resolve();
  poller.invalidate(); resolve(['stale']); await pending;
  assert.deepEqual(applied, []);
});

test('a metadata transport failure leaves existing provider state intact', async () => {
  const poller = createProviderStatusPoller({ read: () => { throw new Error('offline'); }, apply: () => assert.fail('must not overwrite') });
  await poller.poll();
});

test('opening the model picker refreshes early but repeated opens stay throttled', async () => {
  let time = 0, complete;
  const calls = [], busy = [], applied = [];
  const poller = createProviderStatusPoller({ now: () => time,
    read: options => { calls.push(options); return new Promise(resolve => { complete = resolve; }); },
    apply: value => applied.push(value), onBusy: value => busy.push(value) });
  let pending = poller.poll(); await Promise.resolve(); complete(['initial']); await pending;
  time = 10_000;
  pending = poller.poll({ force: true });
  assert.equal(poller.poll({ force: true }), pending, 'coalesces two composers');
  await Promise.resolve(); complete(['new-model']); await pending;
  await poller.poll({ force: true });
  assert.deepEqual(calls, [{ force: false }, { force: true }]);
  assert.deepEqual(applied, [['initial'], ['new-model']]);
  assert.deepEqual(busy, [true, false, true, false]);
});

test('catalogue-only and alias-version changes invalidate the provider snapshot', () => {
  const base = { ...connected({ status: 'available' }), modelCatalog: [{ id: 'opus', resolvedModel: 'claude-previous' }] };
  assert.notEqual(providerSnapshotKey([base]), providerSnapshotKey([{ ...base, modelCatalog: [{ id: 'opus', resolvedModel: 'claude-next' }] }]));
  assert.notEqual(providerSnapshotKey([base]), providerSnapshotKey([{ ...base, modelCatalog: [...base.modelCatalog, { id: 'new-family' }] }]));
});
