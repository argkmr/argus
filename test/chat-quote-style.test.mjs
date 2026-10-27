import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const css = (await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8"))
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find((match) => match[1].trim() === selector)?.[2];
  assert.ok(body, `Missing style rule: ${selector}`);
  return Object.fromEntries(body.split(";").flatMap((entry) => {
    const colon = entry.indexOf(":");
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]];
  }));
};

test("quotes use one bounded container with a continuous border and background", () => {
  const quote = rule(".chat-quote");
  assert.equal(quote.display, "flow-root");
  assert.equal(quote["min-width"], "0");
  assert.equal(quote["max-width"], "100%");
  assert.equal(quote.margin, "12px 0");
  assert.equal(quote.padding, "12px 14px");
  assert.equal(quote["border-left"], "2px solid var(--accent)");
  assert.equal(quote["border-radius"], "0 8px 8px 0");
  assert.equal(quote.background, "color-mix(in srgb, var(--accent) 6%, transparent)");
});

test("paragraphs, lists, code, tables and nested quotes share compact inner spacing", () => {
  const content = rule(".chat-quote > :is(.chat-paragraph, .chat-list, .chat-code-block, .chat-table-scroll, .chat-quote)");
  assert.equal(content["margin-block"], "0 .75em");
  assert.equal(rule(".chat-quote > :first-child")["margin-top"], "0");
  assert.equal(rule(".chat-quote > :last-child")["margin-bottom"], "0");
  // Body blocks retain their existing non-quote rhythm.
  assert.equal(rule(".chat-paragraph").margin, "0 0 10px");
  assert.equal(rule(".chat-list").margin, "7px 0 12px");
  assert.equal(rule(".chat-code-block").margin, "8px 0 10px");
});

test("quotes inherit the selected app font and Nexus theme without overriding typography", () => {
  const quote = rule(".chat-quote");
  assert.equal(quote.font, "inherit");
  assert.equal(quote.color, "var(--muted)");
  for (const property of ["font-family", "font-size", "line-height", "font-weight", "zoom", "transform"])
    assert.equal(quote[property], undefined);
  const nexus = rule("#global-codex-panel .chat-quote");
  assert.equal(nexus.color, "var(--muted)");
  assert.equal(nexus.background, "var(--surface-2)");
  assert.equal(nexus["border-left-color"], "var(--accent)");
  for (const property of ["font", "font-family", "font-size", "padding", "margin"])
    assert.equal(nexus[property], undefined);
});

test("long quote links wrap while code keeps its existing horizontal scroll", () => {
  assert.equal(rule(".chat-quote")["overflow-wrap"], "anywhere");
  assert.equal(rule(".chat-file-reference")["overflow-wrap"], "anywhere");
  assert.equal(rule(".chat-file-reference")["white-space"], "normal");
  assert.equal(rule(".chat-code-block pre").overflow, "auto");
  assert.equal(rule(".chat-code-block code")["white-space"], "pre");
  assert.equal(rule(".chat-code-block code")["overflow-wrap"], "normal");
  assert.equal(rule(".chat-table-scroll").overflow, "auto hidden");
});
