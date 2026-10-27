import assert from "node:assert/strict";
import test from "node:test";
import {
  repositoryTabFocusIndex,
  repositoryTabRevealLeft,
  repositoryTabScrollState,
  repositoryTabWheelDelta,
} from "../public/repository-tab-navigation.mjs";

test("repository arrows reflect the scrollable range with a two-pixel edge tolerance", () => {
  const dimensions = { scrollWidth: 1000, clientWidth: 300 };
  assert.deepEqual(repositoryTabScrollState({ ...dimensions, scrollLeft: 0 }), {
    overflow: true, canScrollLeft: false, canScrollRight: true, maxScrollLeft: 700, scrollLeft: 0,
  });
  assert.deepEqual(repositoryTabScrollState({ ...dimensions, scrollLeft: 350 }), {
    overflow: true, canScrollLeft: true, canScrollRight: true, maxScrollLeft: 700, scrollLeft: 350,
  });
  assert.deepEqual(repositoryTabScrollState({ ...dimensions, scrollLeft: 700 }), {
    overflow: true, canScrollLeft: true, canScrollRight: false, maxScrollLeft: 700, scrollLeft: 700,
  });
  assert.equal(repositoryTabScrollState({ ...dimensions, scrollLeft: 1.5 }).canScrollLeft, false);
  assert.equal(repositoryTabScrollState({ ...dimensions, scrollLeft: 698.5 }).canScrollRight, false);
  assert.equal(repositoryTabScrollState({ ...dimensions, scrollLeft: 2.5 }).canScrollLeft, true);
  assert.equal(repositoryTabScrollState({ ...dimensions, scrollLeft: 697.5 }).canScrollRight, true);
});

test("repository scrolling clamps elastic overscroll and does not expose arrows for a fitting rail", () => {
  const dimensions = { scrollWidth: 1000, clientWidth: 300 };
  assert.equal(repositoryTabScrollState({ ...dimensions, scrollLeft: -25 }).scrollLeft, 0);
  assert.equal(repositoryTabScrollState({ ...dimensions, scrollLeft: 740 }).scrollLeft, 700);
  for (const scrollWidth of [0, 250, 300, 302]) {
    const result = repositoryTabScrollState({ scrollLeft: 0, scrollWidth, clientWidth: 300 });
    assert.equal(result.overflow, false);
    assert.equal(result.canScrollLeft, false);
    assert.equal(result.canScrollRight, false);
  }
});

test("revealing a repository uses viewport rectangles even when its parent has a separate offset", () => {
  const dimensions = { scrollLeft: 100, clientWidth: 300, railLeft: 200, scrollWidth: 1000 };
  assert.equal(repositoryTabRevealLeft({ ...dimensions, tabLeft: 220, tabRight: 480 }), null);
  assert.equal(repositoryTabRevealLeft({ ...dimensions, tabLeft: 150, tabRight: 240 }), 46);
  assert.equal(repositoryTabRevealLeft({ ...dimensions, tabLeft: 460, tabRight: 560 }), 164);
});

test("repository reveal clamps at both ends and aligns oversized tabs to their leading edge", () => {
  const dimensions = { clientWidth: 300, railLeft: 200, scrollWidth: 1000 };
  assert.equal(repositoryTabRevealLeft({ ...dimensions, scrollLeft: 20, tabLeft: 150, tabRight: 240 }), 0);
  assert.equal(repositoryTabRevealLeft({ ...dimensions, scrollLeft: 680, tabLeft: 480, tabRight: 580 }), 700);
  assert.equal(repositoryTabRevealLeft({ ...dimensions, scrollLeft: 100, tabLeft: 250, tabRight: 650 }), 146);
  assert.equal(repositoryTabRevealLeft({ ...dimensions, scrollWidth: 280, scrollLeft: 0, tabLeft: 220, tabRight: 460 }), null);
});

test("vertical wheel input scrolls repositories in pixels, lines, or pages and clamps movement", () => {
  const dimensions = { scrollLeft: 100, clientWidth: 300, scrollWidth: 1000 };
  const wheel = { deltaX: 0, deltaY: 2, deltaMode: 0 };
  assert.equal(repositoryTabWheelDelta(wheel, dimensions), 2);
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaMode: 1 }, dimensions), 32);
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaMode: 2 }, dimensions), 600);
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaY: 80 }, { ...dimensions, scrollLeft: 680 }), 20);
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaY: -30 }, { ...dimensions, scrollLeft: 10 }), -10);
});

test("repository wheel handling leaves horizontal, modifier, zoom, and edge gestures to the browser", () => {
  const dimensions = { scrollLeft: 100, clientWidth: 300, scrollWidth: 1000 };
  const wheel = { deltaX: 0, deltaY: 40, deltaMode: 0 };
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey"]) {
    assert.equal(repositoryTabWheelDelta({ ...wheel, [modifier]: true }, dimensions), 0, modifier);
  }
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaX: 80 }, dimensions), 0);
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaY: 0 }, dimensions), 0);
  assert.equal(repositoryTabWheelDelta({ ...wheel, deltaY: -40 }, { ...dimensions, scrollLeft: 0 }), 0);
  assert.equal(repositoryTabWheelDelta(wheel, { ...dimensions, scrollLeft: 700 }), 0);
  assert.equal(repositoryTabWheelDelta(wheel, { ...dimensions, scrollLeft: 0, scrollWidth: 280 }), 0);
});

test("repository keyboard navigation wraps focus and supports Home and End without inventing activation keys", () => {
  assert.equal(repositoryTabFocusIndex(0, "ArrowLeft", 3), 2);
  assert.equal(repositoryTabFocusIndex(2, "ArrowRight", 3), 0);
  assert.equal(repositoryTabFocusIndex(1, "ArrowLeft", 3), 0);
  assert.equal(repositoryTabFocusIndex(1, "ArrowRight", 3), 2);
  assert.equal(repositoryTabFocusIndex(1, "Home", 3), 0);
  assert.equal(repositoryTabFocusIndex(1, "End", 3), 2);
  assert.equal(repositoryTabFocusIndex(0, "ArrowRight", 1), 0);
  assert.equal(repositoryTabFocusIndex(0, "ArrowRight", 0), null);
  for (const key of ["Enter", " ", "Delete", "Backspace", "Escape", "Tab"]) {
    assert.equal(repositoryTabFocusIndex(1, key, 3), null, key);
  }
});
