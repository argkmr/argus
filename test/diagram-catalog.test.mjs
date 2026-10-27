import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COMPONENT_BRAND_ICONS, DIAGRAM_COMPONENTS, getDiagramComponent, searchDiagramComponents } from "../frontend/features/diagrams/diagram-catalog.mjs";

test("diagram catalog offers distinct infrastructure roles and complete bundled brand marks", () => {
  assert.ok(DIAGRAM_COMPONENTS.length >= 25);
  assert.equal(new Set(DIAGRAM_COMPONENTS.map(({ id }) => id)).size, DIAGRAM_COMPONENTS.length);
  for (const component of DIAGRAM_COMPONENTS) {
    assert.ok(component.id && component.label && component.category && component.role && component.description);
    assert.match(component.color, /^#[a-f\d]{6}$/i);
    if (component.brand) {
      const icon = COMPONENT_BRAND_ICONS[component.brand];
      assert.ok(icon?.path, `Missing bundled icon for ${component.brand}`);
      assert.equal(typeof icon.path, "string");
      assert.ok(!icon.path.includes("<"), "Brand SVG geometry must be a path, not markup");
    }
  }
  assert.equal(getDiagramComponent("redis").role, "cache");
  assert.equal(getDiagramComponent("mongodb").role, "database");
  assert.equal(getDiagramComponent("rabbitmq").role, "queue");
  assert.equal(getDiagramComponent("kafka-topic").role, "topic");
  assert.equal(getDiagramComponent("kafka-topic").brand, "Apache Kafka");
  assert.notEqual(getDiagramComponent("kafka").role, getDiagramComponent("kafka-topic").role);
});

test("component search supports combined vendor and functional terms", () => {
  assert.ok(searchDiagramComponents("KAFKA topic").some(({ id }) => id === "kafka-topic"));
  assert.ok(searchDiagramComponents("redis cache").some(({ id }) => id === "redis"));
  assert.ok(searchDiagramComponents("load balancer").some(({ id }) => id === "load-balancer"));
  assert.equal(searchDiagramComponents("no-such-component-xyz").length, 0);
  assert.equal(searchDiagramComponents(" ").length, DIAGRAM_COMPONENTS.length);
  assert.equal(getDiagramComponent("unknown-future-type").id, "service");
});

test("Redis uses the classic multicolor stacked product mark across catalog entries", () => {
  const icon = COMPONENT_BRAND_ICONS.Redis;
  assert.equal(icon.title, 'Redis');
  assert.equal(icon.viewBox, '0 0 128 128');
  assert.equal(icon.paths.length, 10);
  assert.ok(Object.isFrozen(icon) && Object.isFrozen(icon.paths));
  assert.equal(icon.path, icon.paths.map(({ d }) => d).join(' '));
  assert.deepEqual([...new Set(icon.paths.map(({ fill }) => fill))], ['#A41E11', '#D82C20', '#fff', '#7A0C00', '#AD2115']);
  for (const path of icon.paths) {
    assert.ok(Object.isFrozen(path));
    assert.match(path.d, /^M/);
    assert.ok(!path.d.includes('<'));
  }
  for (const id of ['redis', 'eraser:redis']) {
    const component = getDiagramComponent(id);
    assert.equal(component.id, id);
    assert.equal(component.brand, 'Redis');
    assert.equal(component.role, 'cache');
    assert.equal(component.iconName, undefined, 'Redis must not load the alternative hosted corporate mark');
  }
  assert.equal(getDiagramComponent('eraser:docker').iconName, 'docker', 'Other hosted marks remain unchanged');
});

test("catalog palette reserves space for a large role and small overlay product badge", async () => {
  const css = await readFile(new URL("../frontend/features/diagrams/diagram-studio.css", import.meta.url), "utf8");
  function rule(selector) {
    const start = css.lastIndexOf(`${selector} {`);
    assert.ok(start >= 0, `Missing palette layout rule: ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  }
  const row = rule(".diagram-catalog>button");
  const glyph = rule(".diagram-catalog>button>.diagram-component-glyph");
  const brand = rule(".diagram-catalog .diagram-brand-glyph");
  const role = rule(".diagram-catalog .diagram-role-glyph");
  const column = Number(row.match(/grid-template-columns:\s*(\d+)px\s+minmax\(0,\s*1fr\)/)?.[1]);
  const width = declaration => Number(declaration.match(/(?:^|[;{])\s*width:\s*(\d+)px/)?.[1]);
  assert.equal(column, 36);
  assert.equal(width(glyph), 28);
  assert.equal(width(brand), 12);
  assert.equal(width(role), 28);
  assert.ok(width(glyph) + 5 <= column, 'Badge backing stays inside the icon column');
  assert.match(glyph, /justify-content:\s*center/);
  assert.match(rule(".diagram-catalog>button>strong,.diagram-catalog>button>small"), /min-width:\s*0;\s*overflow-wrap:\s*anywhere/);
});
