import test from "node:test";
import assert from "node:assert/strict";
import { configurationNavigationSymbols, navigationSymbolAt, supportsConfigurationNavigation } from "../public/code-navigation.mjs";

test("Spring configuration targeting is limited to configuration and JVM source files", () => {
  for (const path of ["Main.java", "Config.kt", "build.kts", "application.yml", "application.yaml", "application.properties"]) assert.equal(supportsConfigurationNavigation(path), true);
  for (const path of ["Main.js", "main.ts", "component.tsx", "script.py", "app.json", null]) assert.equal(supportsConfigurationNavigation(path), false);
});

test("configuration targets retain exact dotted, hyphenated and indexed property keys", () => {
  for (const line of ['@Value("${orders.timeout-ms:30}")', 'environment.getProperty("orders.timeout-ms")', "env.getRequiredProperty('orders.timeout-ms', Integer.class)", 'timeout: ${orders.timeout-ms:30}', 'TIMEOUT=${orders.timeout-ms:30}']) {
    const [symbol] = configurationNavigationSymbols(line);
    assert.equal(symbol.word, "orders.timeout-ms");
    assert.equal(line.slice(symbol.startColumn - 1, symbol.endColumn - 1), symbol.word);
    for (let column = symbol.startColumn; column < symbol.endColumn; column++) assert.deepEqual(navigationSymbolAt(line, column), symbol);
    assert.equal(navigationSymbolAt(line, symbol.endColumn), null);
  }
  assert.equal(configurationNavigationSymbols('${clients[0].base-url}')[0].word, 'clients[0].base-url');
  assert.deepEqual(configurationNavigationSymbols('${primary:${fallback:30}}').map(symbol => symbol.word), ['primary', 'fallback']);
});

test("ordinary symbol words remain owned by Monaco and defaults are not treated as keys", () => {
  const word = { word: "MAX_RETRIES", startColumn: 2, endColumn: 13 };
  assert.equal(navigationSymbolAt(" MAX_RETRIES + localValue", 5, word), word);
  assert.equal(navigationSymbolAt('${timeout:30}', 12), null);
  for (const text of ["getProperty(variable)", 'getProperty("prefix." + suffix)', '${}', '${not a key}', '${' + 'a'.repeat(257) + '}']) assert.deepEqual(configurationNavigationSymbols(text), []);
  assert.deepEqual(configurationNavigationSymbols(undefined), []);
});

test("Kotlin interpolation is not confused with escaped Spring placeholders", () => {
  assert.deepEqual(configurationNavigationSymbols('val name = "${customer.name}"', "Config.kt"), []);
  assert.equal(configurationNavigationSymbols('val name = "\\${orders.timeout-ms}"', "Config.kt")[0].word, "orders.timeout-ms");
  assert.deepEqual(configurationNavigationSymbols('val name = "\\\\${customer.name}"', "Config.kt"), []);
  assert.equal(configurationNavigationSymbols('env.getProperty("orders.timeout-ms")', "Config.kt")[0].word, "orders.timeout-ms");
});
