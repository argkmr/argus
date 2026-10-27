import test from "node:test";
import assert from "node:assert/strict";
import { createAppNavigationHistory } from "../public/app-navigation-history.mjs";

test("app history keeps exactly ten previous and ten forward navigation states", () => {
  const history = createAppNavigationHistory();
  for (let index = 0; index <= 30; index++) history.record({ route: `/repositories/${index}` });
  assert.equal(history.backCount, 10);
  for (let index = 29; index >= 20; index--) assert.equal(history.move(-1).route, `/repositories/${index}`);
  assert.equal(history.move(-1), null);
  assert.equal(history.forwardCount, 10);
  for (let index = 21; index <= 30; index++) assert.equal(history.move(1).route, `/repositories/${index}`);
  assert.equal(history.move(1), null);
  assert.equal(history.backCount, 10);
});

test("a new destination clears forward history; duplicate paints do not create steps", () => {
  const history = createAppNavigationHistory();
  history.record({ route: "/global-ai" });
  history.record({ route: "/services" });
  assert.equal(history.record({ route: "/services" }), false);
  history.move(-1);
  history.record({ route: "/agents" });
  assert.equal(history.forwardCount, 0);
  assert.deepEqual(history.move(-1), { route: "/global-ai" });
});

test("peek does not consume a state when navigation is cancelled", () => {
  const history = createAppNavigationHistory();
  history.record({ route: "/repositories/a", editor: { path: "a.java", line: 10 } });
  history.record({ route: "/repositories/a", editor: { path: "b.java", line: 12 } });
  const target = history.peek(-1); target.editor.line = 999;
  assert.equal(history.backCount, 1);
  assert.equal(history.current.editor.path, "b.java");
  assert.equal(history.move(-1).editor.line, 10);
});

test("replacement updates the current destination without adding or erasing forward steps", () => {
  const history = createAppNavigationHistory();
  history.record({ route: "/repositories/a" }); history.record({ route: "/global-ai" });
  history.move(-1);
  history.record({ route: "/repositories/a", editor: { path: "a.java", line: 4 } }, { replace: true });
  assert.equal(history.backCount, 0); assert.equal(history.forwardCount, 1);
  history.move(1); assert.equal(history.move(-1).editor.line, 4);
});
