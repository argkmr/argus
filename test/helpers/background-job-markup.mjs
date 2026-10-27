import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
const names = ["escapeHtml", "backgroundJobIsActive", "backgroundJobStatusLabel", "backgroundJobRepositoryMarkup", "backgroundJobMarkup"];
const declarations = names.map(name => {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  if (start < 0) throw new Error(`Missing production function: ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
});
const context = vm.createContext({ state: { backgroundJobLogExpanded: new Map() } });
vm.runInContext(declarations.join("\n"), context);

export const renderJob = job => context.backgroundJobMarkup(job);
export const renderRepositories = job => context.backgroundJobRepositoryMarkup(job);

export function kitJob(overrides = {}) {
  return {
    id: "fixture-kit", type: "ai-kit-generation", title: "Updating AI kits from production changes",
    status: "completed", total: 3, completed: 3, failed: 0, percent: 100,
    message: "3 production-branch AI kits are ready.",
    items: ["checkout-api", "customer-support", "notification-service"].map((name, index) => ({ name, repositoryId: `repo-${index}`, status: "completed" })),
    logs: [{ repository: "checkout-api", stage: "AI kit", message: "Production entry points verified." }],
    ...overrides,
  };
}
