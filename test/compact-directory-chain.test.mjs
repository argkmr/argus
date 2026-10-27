import test from "node:test";
import assert from "node:assert/strict";
import { compactDirectoryChain } from "../public/compact-directory-chain.mjs";

const directory = path => ({ path, name: path.split("/").at(-1), directory: true });
const file = path => ({ path, name: path.split("/").at(-1), directory: false });
const listing = (...entries) => ({ entries, truncated: false });
const neverRead = () => assert.fail("A directory boundary must not trigger speculative reads");

function chainFixture(start, segments, terminal = listing(file(`${start}/${segments.join("/")}/example.txt`))) {
  const entries = segments.map((_, index) => directory(`${start}/${segments.slice(0, index + 1).join("/")}`));
  const initial = listing(entries[0]);
  const responses = new Map(entries.map((entry, index) => [entry.path, index + 1 < entries.length ? listing(entries[index + 1]) : terminal]));
  const reads = [];
  return {
    entries, initial, terminal, reads,
    async read(path, remainingBudgetMs) {
      reads.push({ path, remainingBudgetMs });
      assert.ok(responses.has(path), `Unexpected path read: ${path}`);
      assert.ok(remainingBudgetMs > 0, "Only a positive remaining request budget may be used");
      return responses.get(path);
    },
  };
}

for (const [language, start, segments, filename] of [
  ["Java", "src", ["main", "java", "com", "licious", "post", "order", "cx", "bff", "web"], "Controller.java"],
  ["Ruby", "lib", ["billing", "payments", "gateways"], "stripe.rb"],
  ["Python", "src", ["company", "products", "api"], "routes.py"],
  ["Node / TypeScript", "packages", ["web", "src", "features", "checkout"], "index.ts"],
]) {
  test(`compact folder chains are language-independent: ${language}`, async () => {
    const last = `${start}/${segments.join("/")}`;
    const fixture = chainFixture(start, segments, listing(file(`${last}/${filename}`)));
    const result = await compactDirectoryChain({ path: start, listing: fixture.initial, read: fixture.read });
    assert.deepEqual(result, { path: last, chain: fixture.entries, listing: fixture.terminal });
    assert.deepEqual(fixture.reads.map(read => read.path), fixture.entries.map(entry => entry.path));
    assert.ok(!fixture.reads.some(read => read.path === start), "The supplied initial listing must not be fetched again");
  });
}

for (const [label, initial] of [
  ["an empty directory", listing()],
  ["one file", listing(file("src/index.js"))],
  ["a branch of directories", listing(directory("src/api"), directory("src/ui"))],
  ["a file next to one directory", listing(directory("src/api"), file("src/index.js"))],
  ["a truncated directory listing", { entries: [directory("src/api")], truncated: true }],
  ["a missing entries list", {}],
  ["a non-array entries list", { entries: { path: "src/api", directory: true } }],
]) {
  test(`compaction stops at ${label}`, async () => {
    assert.deepEqual(await compactDirectoryChain({ path: "src", listing: initial, read: neverRead }), {
      path: "src", chain: [], listing: initial,
    });
  });
}

for (const name of [".keep", ".DS_Store", "__init__.py", "package.json"]) {
  test(`a meaningful ${name} file prevents folder compaction`, async () => {
    const initial = listing(directory("src/nested"), file(`src/${name}`));
    const result = await compactDirectoryChain({ path: "src", listing: initial, read: neverRead });
    assert.deepEqual(result, { path: "src", chain: [], listing: initial });
  });
}

test("a successfully loaded empty terminal directory remains part of the chain", async () => {
  const fixture = chainFixture("src", ["empty"], listing());
  assert.deepEqual(await compactDirectoryChain({ path: "src", listing: fixture.initial, read: fixture.read }), {
    path: "src/empty", chain: fixture.entries, listing: fixture.terminal,
  });
});

test("a fetched truncated listing is retained but its apparent single child is not compacted", async () => {
  const terminal = { entries: [directory("src/api/maybe")], truncated: true };
  const fixture = chainFixture("src", ["api"], terminal);
  const result = await compactDirectoryChain({ path: "src", listing: fixture.initial, read: fixture.read });
  assert.deepEqual(result, { path: "src/api", chain: fixture.entries, listing: terminal });
  assert.equal(fixture.reads.length, 1);
});

test("paths, case, Unicode and whitespace are preserved without inferring package names", async () => {
  const fixture = chainFixture("Packages", ["API", "Support Tools", "資料", "a.b", "x&y"]);
  const result = await compactDirectoryChain({ path: "Packages", listing: fixture.initial, read: fixture.read });
  assert.equal(result.path, "Packages/API/Support Tools/資料/a.b/x&y");
  assert.deepEqual(result.chain, fixture.entries);
  assert.deepEqual(fixture.reads.map(read => read.path), fixture.entries.map(entry => entry.path));
});

for (const [label, child] of [
  ["null entry", null],
  ["string entry", "src/api"],
  ["missing child path", { directory: true }],
  ["non-string child path", { directory: true, path: 7 }],
  ["empty child path", directory("")],
  ["same path", directory("src")],
  ["parent path", directory(".")],
  ["absolute path", directory("/src/api")],
  ["unrelated parent", directory("other/api")],
  ["similar prefix", directory("src-other/api")],
  ["case-changed parent", directory("SRC/api")],
  ["nested rather than immediate child", directory("src/api/deep")],
  ["dot segment", directory("src/.")],
  ["parent traversal", directory("src/..")],
  ["embedded traversal", directory("src/../secret")],
  ["duplicate separator", directory("src//api")],
  ["trailing separator", directory("src/api/")],
  ["backslash separator", directory("src/api\\secret")],
  ["protocol path", directory("file:///src/api")],
  ["NUL byte", directory("src/api\0")],
  ["newline", directory("src/api\n")],
  ["carriage return", directory("src/api\r")],
  ["truthy non-boolean directory flag", { path: "src/api", name: "api", directory: "true" }],
  ["symlink", { ...directory("src/api"), symlink: true }],
  ["symbolic link", { ...directory("src/api"), symbolicLink: true }],
]) {
  test(`invalid or unsafe child stops lookahead: ${label}`, async () => {
    const initial = listing(child);
    assert.deepEqual(await compactDirectoryChain({ path: "src", listing: initial, read: neverRead }), {
      path: "src", chain: [], listing: initial,
    });
  });
}

test("a failure on the first child leaves that child visible for a normal retry", async () => {
  const initial = listing(directory("src/api"));
  let reads = 0;
  const result = await compactDirectoryChain({ path: "src", listing: initial, read: async () => { reads++; throw Error("Permission denied"); } });
  assert.equal(reads, 1);
  assert.deepEqual(result, { path: "src", chain: [], listing: initial });
});

test("a later failure retains only the successful prefix and its last complete listing", async () => {
  const first = directory("src/main"), next = directory("src/main/java");
  const initial = listing(first), firstListing = listing(next), reads = [];
  const result = await compactDirectoryChain({ path: "src", listing: initial, read: async path => {
    reads.push(path);
    if (path === first.path) return firstListing;
    throw Error("Directory disappeared");
  } });
  assert.deepEqual(reads, [first.path, next.path]);
  assert.deepEqual(result, { path: first.path, chain: [first], listing: firstListing });
  assert.equal(result.listing.entries[0], next, "The failed child must remain available to expand");
});

test("failed lookahead is not remembered as a permanently empty folder", async () => {
  const initial = listing(directory("src/api")), terminal = listing(file("src/api/app.py"));
  await compactDirectoryChain({ path: "src", listing: initial, read: () => { throw Error("Temporary failure"); } });
  assert.deepEqual(await compactDirectoryChain({ path: "src", listing: initial, read: async () => terminal }), {
    path: "src/api", chain: initial.entries, listing: terminal,
  });
});

for (const invalidResponse of [null, {}, { entries: null }, { entries: "not an array" }]) {
  test(`malformed fetched listing keeps the original child accessible: ${JSON.stringify(invalidResponse)}`, async () => {
    const initial = listing(directory("src/api"));
    assert.deepEqual(await compactDirectoryChain({ path: "src", listing: initial, read: async () => invalidResponse }), {
      path: "src", chain: [], listing: initial,
    });
  });
}

test("cancelled work performs no reads and yields no stale rendering result", async () => {
  assert.equal(await compactDirectoryChain({ path: "src", listing: listing(directory("src/api")), read: neverRead, isCurrent: () => false }), null);
});

test("cancellation during a pending request discards its result without another request", async () => {
  let resolveRead, current = true, reads = 0;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const result = compactDirectoryChain({ path: "src", listing: listing(directory("src/api")), read: () => { reads++; return pending; }, isCurrent: () => current });
  assert.equal(reads, 1);
  current = false;
  resolveRead(listing(directory("src/api/deep")));
  assert.equal(await result, null);
  assert.equal(reads, 1);
});

test("cancellation combined with a failed request still returns null", async () => {
  let current = true;
  assert.equal(await compactDirectoryChain({ path: "src", listing: listing(directory("src/api")), isCurrent: () => current, read: async () => {
    current = false;
    throw Error("Aborted");
  } }), null);
});

test("an explicit depth cap leaves deeper folders accessible in the retained listing", async () => {
  const fixture = chainFixture("src", ["one", "two", "three", "four", "five"]);
  const result = await compactDirectoryChain({ path: "src", listing: fixture.initial, read: fixture.read, maxDepth: 3 });
  assert.equal(fixture.reads.length, 3);
  assert.equal(result.path, "src/one/two/three");
  assert.deepEqual(result.chain, fixture.entries.slice(0, 3));
  assert.deepEqual(result.listing, listing(fixture.entries[3]));
});

test("the default cap bounds arbitrarily deep folder chains to 32 reads", async () => {
  const fixture = chainFixture("src", Array.from({ length: 80 }, (_, i) => `level${i}`));
  const result = await compactDirectoryChain({ path: "src", listing: fixture.initial, read: fixture.read, now: () => 0 });
  assert.equal(fixture.reads.length, 32);
  assert.equal(result.chain.length, 32);
  assert.equal(result.path, fixture.entries[31].path);
  assert.deepEqual(result.listing, listing(fixture.entries[32]));
});

test("a zero depth limit disables speculative reads", async () => {
  const initial = listing(directory("src/api"));
  assert.deepEqual(await compactDirectoryChain({ path: "src", listing: initial, read: neverRead, maxDepth: 0 }), {
    path: "src", chain: [], listing: initial,
  });
});

test("an exhausted time budget performs no reads", async () => {
  const initial = listing(directory("src/api"));
  assert.deepEqual(await compactDirectoryChain({ path: "src", listing: initial, read: neverRead, budgetMs: 0, now: () => 42 }), {
    path: "src", chain: [], listing: initial,
  });
});

test("each speculative request receives only the remaining overall time budget", async () => {
  let clock = 100;
  const fixture = chainFixture("src", ["one", "two", "three", "four"]);
  const result = await compactDirectoryChain({ path: "src", listing: fixture.initial, budgetMs: 100, now: () => clock, read: async (path, remaining) => {
    const response = await fixture.read(path, remaining);
    clock += 50;
    return response;
  } });
  assert.deepEqual(fixture.reads.map(read => read.remainingBudgetMs), [100, 50]);
  assert.equal(result.path, "src/one/two");
  assert.deepEqual(result.chain, fixture.entries.slice(0, 2));
  assert.deepEqual(result.listing, listing(fixture.entries[2]));
});

test("a request consuming the rest of the budget never triggers a further lookahead", async () => {
  let clock = 0;
  const initial = listing(directory("src/api")), terminal = listing(directory("src/api/deep"));
  let reads = 0;
  const result = await compactDirectoryChain({ path: "src", listing: initial, budgetMs: 10, now: () => clock, read: async (_path, remaining) => {
    reads++;
    assert.equal(remaining, 10);
    clock = 20;
    return terminal;
  } });
  assert.equal(reads, 1);
  assert.deepEqual(result, { path: "src/api", chain: initial.entries, listing: terminal });
});

test("compaction does not mutate cached listings or entry metadata", async () => {
  const first = Object.freeze({ ...directory("src/api"), custom: "preserved" });
  const initial = Object.freeze({ entries: Object.freeze([first]), truncated: false });
  const terminal = Object.freeze({ entries: Object.freeze([Object.freeze(file("src/api/index.js"))]), truncated: false });
  const result = await compactDirectoryChain({ path: "src", listing: initial, read: async () => terminal });
  assert.equal(result.listing, terminal);
  assert.equal(result.chain[0], first);
  assert.deepEqual(initial, { entries: [first], truncated: false });
  assert.equal(first.custom, "preserved");
});
