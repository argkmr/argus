import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { developmentConfiguration, javaArguments } from "../scripts/dev.mjs";

test("native development uses private development data and one Java listener", () => {
  const configuration = developmentConfiguration({ PATH: "/fixture/bin" }, "/fixture/argus");
  assert.equal(configuration.environment.ARGUS_PORT, "4173");
  assert.equal(configuration.environment.ARGUS_PUBLIC_PORT, "4173");
  assert.equal(configuration.environment.ARGUS_DATA_DIR, "/fixture/argus/.argus-data/dev");
  assert.equal(configuration.environment.ARGUS_SEMANTIC_DATA_DIR, "/fixture/argus/.argus-data/dev/semantic");
  assert.equal(configuration.environment.ARGUS_API_COLLECTIONS_DIR, "/fixture/argus/.argus-data/dev/api-collections");
  assert.equal(configuration.environment.ARGUS_SOURCE_ROOT, "/fixture/argus");
  assert.match(configuration.environment.ARGUS_MCP_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  const arguments_ = javaArguments(configuration.jar);
  assert.equal(arguments_.some(argument => argument.includes("native-backend-enabled")), false);
  assert.equal(arguments_.at(-1), path.join("/fixture/argus", "backend/target/argus-backend-0.1.0.jar"));
  assert.equal(arguments_.some(argument => argument.includes("server/index.mjs") || argument.includes("legacy-origin")), false);
});

test("explicit development directory and port are honored but invalid ports fail closed", () => {
  const value = developmentConfiguration({ ARGUS_PORT: "4199", ARGUS_DATA_DIR: "/fixture/custom", ARGUS_MCP_TOKEN: "stale" }, "/fixture/argus");
  assert.equal(value.environment.ARGUS_PUBLIC_PORT, "4199");
  assert.equal(value.environment.ARGUS_DATA_DIR, "/fixture/custom");
  assert.notEqual(value.environment.ARGUS_MCP_TOKEN, "stale");
  for (const port of ["0", "65536", "hello", "4173; touch surprise"]) assert.throws(() => developmentConfiguration({ ARGUS_PORT: port }, "/fixture/argus"), /integer/);
});
