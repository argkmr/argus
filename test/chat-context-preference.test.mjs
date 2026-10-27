import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createChatContextPreference } from "../public/chat-context-preference.mjs";
import { modelSelectionKey } from "../public/model-selection.js";

const storageKey = "argus-chat-context-preferences-v1";
function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[storageKey, initial]]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

for (const scope of ["global", "repository"]) {
  test(`${scope}: new and legacy chats default to history without rewriting sent-task metadata`, () => {
    const storage = memoryStorage();
    const preferences = createChatContextPreference(storage);
    for (const taskId of [null, "existing-chat"]) {
      const key = modelSelectionKey(scope, "repo-a", taskId);
      assert.equal(preferences.get(key), "history");
      assert.equal(preferences.has(key), false);
      for (const contextMode of ["fresh", "history", undefined]) {
        const task = Object.freeze({ id: taskId, contextMode });
        assert.equal(preferences.get(key, task), "history");
        assert.equal(task.contextMode, contextMode);
      }
    }
    assert.equal(storage.values.size, 0, "reading defaults must not migrate historical preferences");
  });

  test(`${scope}: manual Fresh survives reload and a stale historical task snapshot`, () => {
    const storage = memoryStorage();
    const key = modelSelectionKey(scope, "repo-a", "chat-a");
    let preferences = createChatContextPreference(storage);
    preferences.set(key, "fresh");
    assert.equal(preferences.has(key), true);
    assert.equal(preferences.get(key, { contextMode: "history" }), "fresh");
    preferences = createChatContextPreference(storage);
    assert.equal(preferences.has(key), true);
    assert.equal(preferences.get(key, { contextMode: "history" }), "fresh");
    preferences.set(key, "history");
    assert.equal(createChatContextPreference(storage).get(key, { contextMode: "fresh" }), "history");
    assert.deepEqual([...storage.values.keys()], [storageKey]);
  });

  test(`${scope}: pending revisions temporarily stay fresh without replacing the follow-up preference`, () => {
    const storage = memoryStorage();
    const key = modelSelectionKey(scope, "repo-a", "chat-a");
    const preferences = createChatContextPreference(storage);
    for (const preference of [undefined, "history", "fresh"]) {
      preferences.reset(key);
      if (preference) preferences.set(key, preference);
      const saved = storage.getItem(storageKey);
      for (const task of [
        { contextMode: "history", revisionDraft: { prompt: "Saved edited request" } },
        { contextMode: "history", revisionOf: { pending: true } },
      ]) {
        assert.equal(preferences.get(key, task), "fresh");
        assert.equal(storage.getItem(storageKey), saved, "revision display must not persist a new preference");
      }
      assert.equal(preferences.get(key, { contextMode: "fresh", revisionOf: { pending: false } }), preference ?? "history");
      assert.equal(preferences.has(key), preference !== undefined);
    }
  });
}

test("manual choices are isolated between Nexus, repositories, tasks and unsent drafts", () => {
  const storage = memoryStorage();
  const keys = [
    modelSelectionKey("global", null, "nexus-a"),
    modelSelectionKey("global", null, "nexus-b"),
    modelSelectionKey("global", null, null),
    modelSelectionKey("repository", "repo-a", "chat-a"),
    modelSelectionKey("repository", "repo-a", "chat-b"),
    modelSelectionKey("repository", "repo-a", null),
    modelSelectionKey("repository", "repo-b", "chat-c"),
    modelSelectionKey("repository", "repo-b", null),
  ];
  const preferences = createChatContextPreference(storage);
  preferences.set(keys[0], "fresh");
  preferences.set(keys[3], "fresh");
  const reloaded = createChatContextPreference(storage);
  keys.forEach((key, index) => assert.equal(reloaded.get(key), [0, 3].includes(index) ? "fresh" : "history"));
  preferences.reset(keys[0]);
  const afterReset = createChatContextPreference(storage);
  assert.equal(afterReset.has(keys[0]), false);
  assert.equal(afterReset.get(keys[0]), "history");
  assert.equal(afterReset.get(keys[3]), "fresh", "reset only removes the requested chat");
});

test("malformed stored JSON or a non-object cache does not break composing", () => {
  for (const raw of ["invalid JSON", "null", "[]", '"fresh"', "23", "true"]) {
    const storage = memoryStorage(raw);
    const preferences = createChatContextPreference(storage);
    assert.equal(preferences.get("chat"), "history");
    assert.equal(preferences.has("chat"), false);
    preferences.set("chat", "fresh");
    assert.equal(preferences.get("chat"), "fresh");
    assert.equal(createChatContextPreference(storage).get("chat"), "fresh");
  }
});

test("invalid stored modes are ignored while valid choices are retained", () => {
  const storage = memoryStorage(JSON.stringify({ freshChat: "fresh", historyChat: "history", old: "auto", absent: null, number: 1, object: {}, list: [] }));
  const preferences = createChatContextPreference(storage);
  assert.equal(preferences.get("freshChat"), "fresh");
  assert.equal(preferences.get("historyChat"), "history");
  assert.equal(preferences.has("historyChat"), true);
  for (const key of ["old", "absent", "number", "object", "list"]) {
    assert.equal(preferences.get(key), "history");
    assert.equal(preferences.has(key), false);
  }
});

test("invalid manual modes are rejected without modifying an existing selection", () => {
  const storage = memoryStorage();
  const preferences = createChatContextPreference(storage);
  preferences.set("chat", "fresh");
  const saved = storage.getItem(storageKey);
  for (const invalid of [undefined, null, "", "auto", "History", 1, false, {}, []]) {
    assert.throws(() => preferences.set("chat", invalid), TypeError);
    assert.equal(preferences.get("chat"), "fresh");
    assert.equal(storage.getItem(storageKey), saved);
  }
});

test("unavailable or full storage preserves manual selection in memory", () => {
  const unavailable = { getItem() { throw new Error("Storage unavailable"); }, setItem() { throw new Error("Storage unavailable"); } };
  const full = { getItem: () => JSON.stringify({ saved: "fresh" }), setItem() { throw new Error("Quota exceeded"); } };
  for (const storage of [undefined, null, unavailable, full]) {
    const preferences = createChatContextPreference(storage);
    assert.equal(preferences.get("new-chat"), "history");
    if (storage === full) assert.equal(preferences.get("saved"), "fresh");
    preferences.set("new-chat", "fresh");
    assert.equal(preferences.get("new-chat"), "fresh");
    assert.equal(preferences.has("new-chat"), true);
    preferences.reset("new-chat");
    assert.equal(preferences.get("new-chat"), "history");
    assert.equal(preferences.has("new-chat"), false);
  }
});

test("both production composers select Include previous chat context in their initial HTML", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of ["agent-context-mode", "global-agent-context-mode"]) {
    const select = new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/select>`).exec(html);
    assert.ok(select, `${id} must exist`);
    const options = [...select[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
    const selected = options.filter(option => /\bselected(?:\s|=|$)/.test(option[1]));
    assert.equal(selected.length, 1, `${id} should have exactly one explicit default`);
    assert.match(selected[0][1], /\bvalue="history"/);
    assert.equal(selected[0][2].trim(), "Include previous chat context");
    assert.ok(options.some(option => /\bvalue="fresh"/.test(option[1])), "Fresh request remains available");
  }
});
