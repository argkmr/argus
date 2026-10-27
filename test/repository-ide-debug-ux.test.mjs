import test from "node:test";
import assert from "node:assert/strict";
import { createDebugConsole, describeDebugSession } from "../public/repository-ide-debug.mjs";

const output = (text, category = "stdout") => ({ event: "output", body: { output: text, category } });

test("debug console accumulates actual output and excludes telemetry and non-output events", () => {
  const log = createDebugConsole();
  assert.equal(log.append(output("first\n")), true);
  assert.equal(log.append({ event: "stopped", body: { reason: "breakpoint" } }), false);
  assert.equal(log.append(output("adapter internal details", "telemetry")), false);
  log.append(output("second\n", "stderr")); log.append(output("third", "console"));
  assert.deepEqual(log.entries, [{ category: "stdout", text: "first\n" }, { category: "stderr", text: "second\n" }, { category: "console", text: "third" }]);
  assert.equal(log.discarded, false);
});

test("debug console is bounded by entry count and total characters and explains trimming", () => {
  const log = createDebugConsole({ maxEntries: 3, maxCharacters: 9 });
  for (const text of ["one", "two", "three", "four"]) log.append(output(text));
  assert.deepEqual(log.entries.map(entry => entry.text), ["three", "four"]);
  assert.equal(log.discarded, true);
  log.append(output("0123456789012345"));
  assert.deepEqual(log.entries, [{ category: "stdout", text: "789012345" }]);
  const many = createDebugConsole({ maxEntries: 2 });
  for (const text of ["a", "b", "c"]) many.append(output(text));
  assert.deepEqual(many.entries.map(entry => entry.text), ["b", "c"]);
});

test("console treats output as text, removes terminal controls, and clearing resets trim state", () => {
  const log = createDebugConsole({ maxEntries: 1 });
  log.append(output("old")); log.append(output("\u001b[31m<script>not HTML</script>\u001b[0m\u0000\n", "unexpected"));
  assert.deepEqual(log.entries, [{ category: "console", text: "<script>not HTML</script>\n" }]);
  log.clear(); assert.deepEqual(log.entries, []); assert.equal(log.discarded, false);
  assert.equal(log.append(output("")), false);
});

test("debug session labels and controls follow reported state, never infer breakpoint hits", () => {
  assert.equal(describeDebugSession(null).label, "Not attached");
  assert.equal(describeDebugSession({ state: "attaching" }).canPause, false);
  assert.equal(describeDebugSession({ state: "attached" }).canPause, true);
  assert.equal(describeDebugSession({ state: "attached" }).canStep, false);
  assert.equal(describeDebugSession({ state: "stopped" }).label, "Paused");
  assert.equal(describeDebugSession({ state: "stopped" }).canStep, true);
  assert.equal(describeDebugSession({ state: "stopped" }, true).canStep, false);
  assert.equal(describeDebugSession({ state: "terminated" }).attached, false);
  assert.equal(describeDebugSession({ state: "unexpected" }).label, "Unknown status");
});
