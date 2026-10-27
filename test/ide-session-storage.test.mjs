import test from "node:test";
import assert from "node:assert/strict";
import { createIdeSessionStorage, sanitizeIdeSessionView, IDE_SESSION_KEY } from "../public/repository-ide-session.mjs";

function fixture() {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  return { data, sessions: createIdeSessionStorage(() => storage) };
}
test("session metadata is versioned, repo/root scoped, bounded, and excludes contents", () => {
  const { data, sessions } = fixture();
  assert.equal(sessions.save({ id: "a", path: "/repo-a" }, { path: "src/a.js", line: 12, column: 4, scrollTop: 120, scrollLeft: 50, content: "SECRET SOURCE", dirty: true }), true);
  assert.deepEqual(sessions.load({ id: "a", path: "/repo-a" }), { path: "src/a.js", line: 12, column: 4, scrollTop: 120, scrollLeft: 50 });
  assert.equal(sessions.load({ id: "a", path: "/other-root" }), null);
  assert.equal(sessions.load({ id: "b", path: "/repo-a" }), null);
  assert.doesNotMatch(data.get(IDE_SESSION_KEY), /SECRET|content|dirty/);
  for (let i = 0; i < 120; i++) sessions.save(`repo-${i}`, { path: "test.txt" });
  assert.equal(JSON.parse(data.get(IDE_SESSION_KEY)).repositories.length, 100);
  assert.equal(sessions.load("repo-0"), null);
  sessions.save("repo-119", null); assert.equal(sessions.load("repo-119"), null);
  assert.equal(sessions.load("repo-118").path, "test.txt");
});
test("malformed, oversized or unsafe session metadata is ignored safely", () => {
  const { data, sessions } = fixture();
  for (const raw of ["{", "null", '{"version":2,"repositories":[]}', "x".repeat(1024 * 1024 + 1)]) {
    data.set(IDE_SESSION_KEY, raw); assert.equal(sessions.load("repo"), null);
    assert.equal(sessions.save("repo", { path: "ok.java" }), true);
  }
  for (const path of ["", "/etc/passwd", "../secret", "src/../secret", "src//a", "src/./a", "C:/a", "http://host/a", "src\\a", "a\0b", "a\nb", "a".repeat(4097)]) assert.equal(sanitizeIdeSessionView({ path }), null);
  assert.deepEqual(sanitizeIdeSessionView({ path: "safe.js", line: -10, column: Infinity, scrollTop: 1e30, scrollLeft: NaN }), { path: "safe.js", line: 1, column: 1, scrollTop: 10_000_000, scrollLeft: 0 });
  data.set(IDE_SESSION_KEY, JSON.stringify({ version: 1, repositories: [null, { id: "repo", root: "", view: { path: "../../bad" } }] }));
  assert.equal(sessions.load("repo"), null);
});
test("blocked or quota-full storage never prevents opening a file or quitting", () => {
  for (const getStorage of [() => null, () => { throw new Error("blocked"); }, () => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } })]) {
    const sessions = createIdeSessionStorage(getStorage);
    assert.equal(sessions.load("a"), null); assert.equal(sessions.save("a", { path: "a.js" }), false);
  }
});
