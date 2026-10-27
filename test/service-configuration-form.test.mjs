import assert from "node:assert/strict";
import test from "node:test";
import { serviceConfigurationInput } from "../public/service-configuration-form.mjs";
const form = values => new Map(Object.entries({ repositoryId: "repo", launchMode: "custom", commandName: "Local", commandExecutable: "python3", commandArguments: '["app.py"]', commandCwd: ".", environmentFormat: "dotenv", environmentInput: "NAME=value", ...values }));
test("custom launch submits exact argument tokens with environment and no shell expansion", () => {
  const input = serviceConfigurationInput(form({ commandArguments: '["app.py","hello world","$VALUE"]', commandPort: "8080" }));
  assert.equal(input.simpleSetup, false);
  assert.deepEqual(input.args, ["app.py", "hello world", "$VALUE"]);
  assert.equal(input.environmentInput, "NAME=value");
  assert.equal(input.port, 8080);
  assert.equal(input.cwd, ".");
});
test("automatic launch preserves detection and does not submit hidden command fields", () => {
  const input = serviceConfigurationInput(form({ launchMode: "detected", commandArguments: "not json" }));
  assert.equal(input.simpleSetup, true);
  assert.equal(input.executable, undefined);
});
test("invalid command input is rejected before a write", () => {
  for (const invalid of [{ commandExecutable: " " }, { commandArguments: "{}" }, { commandArguments: "[123]" }, { commandArguments: "oops" }, { commandPort: "65536" }, { commandPort: "0" }, { commandPort: "1.5" }]) {
    assert.throws(() => serviceConfigurationInput(form(invalid)));
  }
});
test("blank port and working directory support non-web services", () => {
  const input = serviceConfigurationInput(form({ commandPort: "", commandCwd: " " }));
  assert.equal(input.port, null); assert.equal(input.cwd, ".");
});
