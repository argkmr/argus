import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  async function deleteBoard(item) {');
assert.ok(start >= 0);
const handler = source.slice(start, source.indexOf('\n  }', start) + 4);

test('board deletion requires a named irreversible confirmation, including archived boards', async () => {
  for (const accepted of [false, true]) for (const archived of [false, true]) {
    const calls = [], prompts = [];
    let focused = false;
    const item = { id: 'chosen-board', name: 'Board name', archived };
    const context = vm.createContext({
      window: { confirm: message => { prompts.push(message); return accepted; } },
      store: { document: { id: 'chosen-board', name: 'Latest edited name' }, remove: async selected => { calls.push(selected); return true; } },
      boardsRef: { current: { querySelector: () => ({ focus: () => { focused = true; } }) } },
    });
    vm.runInContext(handler, context);
    await context.deleteBoard(item);
    assert.match(prompts[0], /Permanently delete “Latest edited name”/);
    assert.match(prompts[0], /cannot be undone/);
    assert.match(prompts[0], /structured canvas and drawing/);
    assert.equal(calls.length, accepted ? 1 : 0);
    assert.equal(focused, accepted);
    if (accepted) assert.equal(calls[0], item);
  }
});

test('each board has a separate accessible delete control that cannot open or restore it', () => {
  const row = source.slice(source.indexOf('<nav aria-label="Saved diagrams">'), source.indexOf('</nav>', source.indexOf('<nav aria-label="Saved diagrams">')));
  assert.match(row, /className="diagram-board-open"/);
  assert.match(row, /className="diagram-icon-button diagram-board-delete"[^>]+disabled=\{store.busy\}/);
  assert.match(row, /aria-label=\{'Delete board '\+item.name\}/);
  assert.match(row, /onClick=\{\(\)=>void deleteBoard\(item\)\}/);
});
