import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createNexusThemePreference, normalizeNexusThemePreferences, nexusThemePopoverPosition } from '../public/nexus-theme-picker.mjs';

test('popover positioning respects viewport bounds at every Argus font scale', () => {
  for (const scale of [1, 1.12, 1.24]) {
    const size = {width:390*scale,height:500*scale};
    const viewport = {width:909,height:654};
    const position = nexusThemePopoverPosition({left:650,bottom:145},size,viewport,scale);
    assert.ok(position.left*scale >= 12);
    assert.ok(position.left*scale+size.width <= viewport.width-12+0.001);
    assert.ok(position.top*scale >= 12);
    assert.ok(position.top*scale+size.height <= viewport.height-12+0.001);
  }
  assert.deepEqual(nexusThemePopoverPosition({left:100,bottom:100},{width:390,height:500},{width:1440,height:960}), {left:100,top:110});
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(cached = null) {
  const writes = [], changes = [], statuses = [], cache = new Map(cached ? [['argus-nexus-theme', cached]] : []);
  let mode = 'dark';
  const preference = createNexusThemePreference({ storage: { getItem: k => cache.get(k), setItem: (k,v) => cache.set(k,v) }, getMode: () => mode, save(id, selections) { const request=deferred(); writes.push({id,selections,...request}); return request.promise; }, onChange: id => changes.push(id), onStatus: s => statuses.push(s) });
  return {preference,writes,changes,statuses,cache,setMode(value) { mode=value;preference.refreshAppearance(); }};
}
test('workspace restores authoritatively over stale paint cache without writes', () => {
  const h=harness('ember'); assert.equal(h.preference.selected,'ember');
  h.preference.restore('ocean'); assert.equal(h.preference.selected,'ocean'); assert.deepEqual(h.writes,[]);
  assert.equal(h.cache.get('argus-nexus-theme'),'ocean');
});
test('invalid cached and saved values fall back to Midnight', () => {
  const h=harness('<script>'); assert.equal(h.preference.selected,'midnight');
  h.preference.restore('unknown'); assert.equal(h.preference.selected,'midnight');
});
test('user choice made during startup cannot be replaced by delayed workspace GET', async () => {
  const h=harness(); const write=h.preference.select('violet'); h.preference.restore('forest');
  assert.equal(h.preference.selected,'violet'); await Promise.resolve();h.writes[0].resolve();await write;
});
test('slow earlier save finishes before latest choice; stale acknowledgements never repaint', async () => {
  const h=harness(); const first=h.preference.select('ocean');await Promise.resolve();
  const last=h.preference.select('rose');assert.equal(h.writes.length,1);assert.equal(h.preference.selected,'violet');
  h.writes[0].resolve();await first;await Promise.resolve();assert.equal(h.writes[1].id,'violet');
  assert.deepEqual(h.changes,['ocean','violet']);assert.equal(h.statuses.at(-1),'saving');
  h.writes[1].resolve();await last;assert.equal(h.statuses.at(-1),'saved');
});
test('rapid queued choices coalesce to latest and do not issue unordered writes', async () => {
  const h=harness(); const a=h.preference.select('ocean'),b=h.preference.select('forest'),c=h.preference.select('graphite');
  await a;await b;await Promise.resolve();assert.deepEqual(h.writes.map(w=>w.id),['graphite']);
  h.writes[0].resolve();await c;
});
test('an old failed save cannot show a failure for the newer successful choice', async () => {
  const h=harness();const a=h.preference.select('ocean');await Promise.resolve();const b=h.preference.select('teal');
  h.writes[0].reject(Error('offline'));await a;await Promise.resolve();assert.ok(!h.statuses.includes('error'));
  h.writes[1].resolve();await b;assert.equal(h.statuses.at(-1),'saved');
});
test('failed save retains preview and exposes an explicit working retry', async () => {
  const h=harness();const a=h.preference.select('sand');await Promise.resolve();h.writes[0].reject(Error('offline'));await a;
  assert.equal(h.preference.selected,'ember');assert.equal(h.statuses.at(-1),'error');
  const retry=h.preference.retry();await Promise.resolve();h.writes[1].resolve();await retry;assert.equal(h.statuses.at(-1),'saved');
});
test('unavailable localStorage does not prevent Java persistence', async () => {
  const writes=[]; const p=createNexusThemePreference({storage:{getItem(){throw Error();},setItem(){throw Error();}},save:async id=>writes.push(id)});
  p.restore('teal');await p.select('indigo');assert.deepEqual(writes,['midnight']);
});

test('new preferences default to Deep Ocean dark and Porcelain light without a write', () => {
  const h=harness();
  assert.deepEqual(h.preference.selections,{dark:'ocean',light:'midnight'});
  assert.equal(h.preference.selected,'ocean');h.setMode('light');assert.equal(h.preference.selected,'midnight');
  assert.deepEqual(h.writes,[]);
});
test('legacy preferences seed both modes while retired saved IDs migrate to their closest palette', () => {
  const h=harness('sand');
  assert.deepEqual(h.preference.selections,{dark:'ember',light:'ember'});
  h.preference.restore('teal');assert.deepEqual(h.preference.selections,{dark:'forest',light:'forest'});
  assert.deepEqual(h.writes,[]);
  assert.deepEqual(JSON.parse(h.cache.get('argus-nexus-themes')),{dark:'forest',light:'forest'});
});
test('dark and light choices persist independently and changing appearance does not issue a save', async () => {
  const h=harness();const first=h.preference.select('forest');await Promise.resolve();h.writes[0].resolve();await first;
  h.setMode('light');assert.equal(h.preference.selected,'midnight');
  const second=h.preference.select('violet');await Promise.resolve();h.writes[1].resolve();await second;
  assert.deepEqual(h.writes[1].selections,{dark:'forest',light:'violet'});
  h.setMode('dark');assert.equal(h.preference.selected,'forest');h.setMode('light');assert.equal(h.preference.selected,'violet');
  assert.equal(h.writes.length,2);
  assert.deepEqual(JSON.parse(h.cache.get('argus-nexus-themes')),{dark:'forest',light:'violet'});
  const copy=h.preference.selections;copy.dark='ember';assert.equal(h.preference.selections.dark,'forest');
});
test('a cross-appearance choice made during an earlier save includes both latest selections', async () => {
  const h=harness();const first=h.preference.select('forest');await Promise.resolve();
  h.setMode('light');const second=h.preference.select('graphite');
  h.writes[0].resolve();await first;await Promise.resolve();
  assert.deepEqual(h.writes[0].selections,{dark:'forest',light:'midnight'});
  assert.deepEqual(h.writes[1].selections,{dark:'forest',light:'graphite'});
  h.writes[1].resolve();await second;
  h.setMode('dark');assert.equal(h.preference.selected,'forest');
});
test('workspace map is authoritative over cached map without writing to the backend', () => {
  const cache=new Map([['argus-nexus-themes',JSON.stringify({dark:'forest',light:'ember'})]]),writes=[];
  const preference=createNexusThemePreference({storage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},save:async(...args)=>writes.push(args)});
  assert.deepEqual(preference.selections,{dark:'forest',light:'ember'});
  preference.restore({dark:'ocean',light:'midnight'});
  assert.deepEqual(preference.selections,{dark:'ocean',light:'midnight'});assert.deepEqual(writes,[]);
});
test('corrupt mode cache falls back to the legacy cache and invalid preference shapes stay bounded', () => {
  const cache=new Map([['argus-nexus-themes','{broken'],['argus-nexus-theme','ember']]);
  const preference=createNexusThemePreference({storage:{getItem:k=>cache.get(k)},save:async()=>{}});
  assert.deepEqual(preference.selections,{dark:'ember',light:'ember'});
  for(const value of [undefined,null,{},[],42,false]) assert.deepEqual(normalizeNexusThemePreferences(value),{dark:'ocean',light:'midnight'});
  assert.deepEqual(normalizeNexusThemePreferences({dark:'__proto__',light:'<script>'}),{dark:'midnight',light:'midnight'});
});
test('picker is local-only, adapts to appearance, retains active controls and patches only its key', async () => {
  const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const module=await fs.readFile(new URL('../public/nexus-theme-picker.mjs',import.meta.url),'utf8');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(app,/save: \(nexusTheme, nexusThemes\) => api\("\/api\/preferences", \{ method: "PATCH", body: \{ nexusTheme, nexusThemes \} \}\)/);
  assert.match(app,/nexusThemePicker.restore\(state.workspace.preferences\?\.nexusThemes \?\? state.workspace.preferences\?\.nexusTheme\)/);
  assert.match(module,/attributeFilter: \['data-theme'\]/);
  assert.match(html,/id="nexus-theme-picker" popover="auto" role="dialog"/);
  assert.match(html,/data-nexus-appearance="light"/);
  assert.match(html,/data-theme-save-status role="status" aria-live="polite"/);
  assert.doesNotMatch(module,/switchPrimaryView|activeTaskByRepository|activeGlobalTaskId|runAgent|innerHTML|fetch\(/);
});
