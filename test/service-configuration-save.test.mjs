import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { serviceConfigurationInput } from "../public/service-configuration-form.mjs";
const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("async function saveService("), source.indexOf("function setEnvironmentFormat("));
function harness() {
  const fields = Object.fromEntries(Object.entries({ configurationId: "", repositoryId: "repo", launchMode: "custom", commandExecutable: "python3", commandArguments: '["app.py"]', commandCwd: ".", commandPort: "" }).map(([name,value]) => [name,{value,disabled:false}]));
  const form = {elements:fields};
  const state = {}, notices = [], writes = [];
  const controls = Object.entries(fields).filter(([key]) => key.startsWith("command")).map(([,value]) => value);
  const nodes = {"#service-form":form,"#service-command-fields":{hidden:false,querySelectorAll:()=>controls},"#application-yaml-section":{classList:{contains:()=>true}},"#save-service":{},"#service-dialog":{close(){}}};
  const context = vm.createContext({ state,serviceOperations:new Map(),serviceConfigurationInput,
    FormData:class {constructor(form){this.values=new Map(Object.entries(form.elements).filter(([,value])=>!value.disabled).map(([key,control])=>[key,control.value]));}get(key){return this.values.get(key);}},
    $: id => nodes[id], api: async (_path, options) => {writes.push(options.body);return{id:"saved-config",repositoryId:"repo"};},
    loadWorkspaceSnapshot: async () => {throw Error("refresh offline");},rememberServiceConfiguration(){},renderServices(){},refreshProcesses:async()=>{},refreshActiveRepository:async()=>{},toast:message=>notices.push(message)
  });
  vm.runInContext(functions,context);
  return {context,state,fields,notices,writes,run:()=>context.saveService({preventDefault(){},currentTarget:form})};
}
test("successful save followed by failed refresh retains the configuration ID for a safe retry", async () => {
  const h=harness();await h.run();await h.run();
  assert.equal(h.writes[0].id,undefined);
  assert.equal(h.fields.configurationId.value,"saved-config");
  assert.equal(h.writes[1].id,"saved-config");
  assert.match(h.notices[0],/Configuration saved.*same service/);
  assert.equal(h.state.serviceConfigurationSaving,false);
});
test("automatic mode disables hidden custom constraints and re-enables them on return", () => {
  const h=harness();h.fields.commandPort.value="65536";
  h.fields.launchMode.value="detected";
  h.context.renderServiceLaunchMode();
  assert.equal(h.fields.commandExecutable.disabled,true);
  assert.equal(h.fields.commandArguments.disabled,true);
  assert.equal(h.fields.commandPort.disabled,true);
  assert.equal(h.fields.commandExecutable.required,false);
  h.fields.launchMode.value="custom";h.context.renderServiceLaunchMode();
  assert.equal(h.fields.commandExecutable.disabled,false);
  assert.equal(h.fields.commandExecutable.required,true);
});
