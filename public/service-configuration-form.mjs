export function serviceConfigurationInput(form) {
  const manual = form.get("launchMode") === "custom";
  const result = {
    simpleSetup: !manual, launchSource: manual ? "custom" : "detected", id: form.get("configurationId") || undefined,
    repositoryId: form.get("repositoryId"), environmentFormat: form.get("environmentFormat"),
    environmentInput: form.get("environmentInput"), configFile: form.get("configFile"), applicationYaml: form.get("applicationYaml"),
  };
  if (!manual) return result;
  const executable = String(form.get("commandExecutable") || "").trim();
  if (!executable) throw new Error("Enter an executable for the custom command.");
  let args;
  try { args = JSON.parse(String(form.get("commandArguments") || "[]")); }
  catch { throw new Error('Arguments must be a JSON array, for example ["run", "dev"].'); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Each command argument must be a string in a JSON array.");
  const portText = String(form.get("commandPort") || "").trim();
  if (portText && (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)) throw new Error("Port must be a whole number from 1 to 65535, or left blank.");
  return { ...result, name: String(form.get("commandName") || "").trim(), executable, args,
    cwd: String(form.get("commandCwd") || ".").trim() || ".", port: portText ? Number(portText) : null };
}
