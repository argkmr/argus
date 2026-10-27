import { createRepositoryIde } from "/legacy/repository-ide.mjs";
import { createIdeRunControls } from "/legacy/ide-run-controls.mjs";
import { createRepositoryTerminal } from "/legacy/repository-terminal.mjs";
import { createIdeUxServices } from "/ide-ux-services.mjs";

const services = createIdeUxServices({ onChange: () => renderServices() });
let repository = services.repositories[0], repositoryId = repository.id, ide, terminalSlot;
const sourcePath = "src/main/java/example/ReviewService.java";
const helperPath = "src/main/java/example/ReviewValidator.java";
const source = `package example;

import java.util.List;

/** Synthetic fixture: this class is never compiled or executed. */
public final class ReviewService {
  private final ReviewValidator validator = new ReviewValidator();

  public Review createReview(String customerId, int rating) {
    validator.validate(rating);
    var review = new Review(customerId, rating);
    return review;
  }

  public List<Review> findReviews(String customerId) {
    return List.of(new Review(customerId, 5));
  }

  record Review(String customerId, int rating) {}
}
`;
const files = new Map([
  [sourcePath, { path: sourcePath, content: source, language: "java", contentHash: "synthetic-source-v1" }],
  [helperPath, { path: helperPath, language: "java", contentHash: "synthetic-helper-v1", content: `package example;

public final class ReviewValidator {
  public void validate(int rating) {
    if (rating < 1 || rating > 5) {
      throw new IllegalArgumentException("Rating must be 1–5");
    }
  }
}
` }],
  ["README.md", { path: "README.md", content: "# Isolated QA\n\nAll code, saves and debugger replies are synthetic and in memory.\n", language: "markdown", contentHash: "synthetic-readme-v1" }],
]);
let session = null, sequence = 0, sessionSequence = 0, targetMode = "listening", line = 10, chatVisible = true;
const events = [], breakpoints = new Map();
const status = document.querySelector("#fixture-status");
const copy = value => structuredClone(value);
const filesByRepository = new Map(services.repositories.map(item => [item.id, new Map([...files].map(([path, file]) => [path, copy(file)]))]));
const inform = (message, error = false) => { status.textContent = message; status.dataset.error = String(error); };
const emit = (event, body = {}) => events.push({ seq: ++sequence, event, body });
function paused(reason = "breakpoint") {
  if (!session) { inform("Attach to the synthetic debug target first."); return; }
  session.state = "stopped"; session.threadId = 1;
  emit("stopped", { reason, threadId: 1, allThreadsStopped: true });
}
function listing(directory) {
  const prefix = directory ? `${directory}/` : "", entries = new Map();
  for (const pathname of files.keys()) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length), name = rest.split("/")[0];
    entries.set(name, { name, path: `${prefix}${name}`, directory: rest.includes("/") });
  }
  return { path: directory, entries: [...entries.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
}
const language = { language: "java", label: "Java", available: true, running: true, ready: true, trustedProject: true, notice: "Synthetic language metadata — no language server is launched." };
async function mockApi(raw, options = {}) {
  if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const url = new URL(raw, location.origin), prefix = `/api/repositories/${repositoryId}/ide`;
  if (url.pathname === "/api/processes" || url.pathname.startsWith("/api/processes/") || url.pathname.startsWith("/api/run-configurations/") || /\/terminal(?:\/|$)/.test(url.pathname)) return services.api(raw, options);
  if (!url.pathname.startsWith(`${prefix}/`)) throw new Error("Fixture rejected a non-synthetic repository request");
  const endpoint = url.pathname.slice(prefix.length), body = options.body || {};
  const repositoryFiles = filesByRepository.get(repositoryId);
  if (endpoint === "/status") return { languages: [copy(language)] };
  if (endpoint === "/tree") return listing(url.searchParams.get("path") || "");
  if (endpoint === "/file") {
    const path = body.path || url.searchParams.get("path"), file = repositoryFiles.get(path);
    if (!file) throw new Error("Only the synthetic fixture files are available");
    if (options.method === "PUT") {
      if (body.expectedHash !== file.contentHash) throw Object.assign(new Error("Synthetic version conflict"), { status: 409 });
      file.content = body.content; file.contentHash = `synthetic-save-${Date.now()}`;
      inform("Saved only to preview memory. No disk file was written.");
    }
    return copy(file);
  }
  if (endpoint === "/symbols") return { results: [{ name: "createReview(customerId, rating)", path: sourcePath, line: 9, column: 17 }, { name: "findReviews(customerId)", path: sourcePath, line: 15, column: 23 }] };
  if (endpoint === "/navigate") return { locations: [{ name: "validate", path: helperPath, line: 4, column: 15 }], notice: "Synthetic navigation result." };
  if (endpoint === "/search") return { results: [...repositoryFiles.values()].filter(file => `${file.path}\n${file.content}`.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())).map(file => ({ path: file.path, name: file.path.split("/").at(-1), line: 1, column: 1, preview: "Synthetic repository file" })) };
  if (["/language/start", "/language/config", "/session"].includes(endpoint)) return { ok: true };
  if (endpoint === "/debug/status") {
    const process = services.processes.find(item => item.repositoryId === repositoryId && item.running && item.debug);
    return {
    adapters: [{ id: "java-jdi", runtime: "java", name: "Java debugger", available: targetMode !== "unavailable", reason: targetMode === "unavailable" ? "Synthetic unavailable-adapter scenario." : undefined }],
    targets: targetMode === "missing" ? [] : [{ name: repository.name, runtime: "java", host: "127.0.0.1", port: process?.debug.port || 5505, processId: process?.id, configurationId: process?.configurationId, state: targetMode === "starting" ? "starting" : "listening" }],
    session: copy(session),
    };
  }
  if (endpoint === "/debug/attach") {
    if (targetMode !== "listening") throw new Error("Synthetic target is not ready to attach");
    session = { id: `synthetic-debug-${++sessionSequence}`, repositoryId, processId: body.processId, configurationId: body.configurationId, adapterId: "java-jdi", port: body.port || 5505, state: "attached", threadId: 1 };
    events.length = 0; sequence = 0;
    emit("output", { category: "console", output: "Connected to synthetic JVM at 127.0.0.1:5505.\n" });
    emit("output", { category: "stdout", output: "[qa-main] Review service ready — waiting for a synthetic request.\n" });
    return { session: copy(session) };
  }
  if (endpoint === "/debug/events") return { session: copy(session), cursor: sequence, events: copy(events.filter(event => event.seq > Number(url.searchParams.get("after") || 0))) };
  if (endpoint === "/debug/session") { session = null; return { detached: true }; }
  if (endpoint === "/debug/command") {
    if (!session) throw new Error("No synthetic debug session is attached");
    const args = body.arguments || {};
    switch (body.command) {
      case "configurationDone": return {};
      case "threads": return { threads: [{ id: 1, name: "main" }, { id: 2, name: "http-worker-1" }] };
      case "stackTrace": return { totalFrames: 2, stackFrames: [{ id: 101, name: "ReviewService.createReview", source: { name: "ReviewService.java", path: sourcePath }, line, column: 5 }, { id: 102, name: "ReviewController.submit", source: { name: "ReviewService.java", path: sourcePath }, line: 15, column: 5 }] };
      case "scopes": return { scopes: [{ name: "Locals", variablesReference: 201, expensive: false }] };
      case "variables": return { variables: args.variablesReference === 202 ? [{ name: "customerId", value: '"qa-customer-42"', type: "String", variablesReference: 0 }, { name: "rating", value: "5", type: "int", variablesReference: 0 }]
        : [{ name: "customerId", value: '"qa-customer-42"', type: "String", variablesReference: 0 }, { name: "rating", value: "5", type: "int", variablesReference: 0 }, { name: "review", value: "Review@7f2", type: "Review", variablesReference: 202 }, { name: "requestId", value: '"synthetic-request-001"', type: "String", variablesReference: 0 }] };
      case "setBreakpoints": {
        const points = (args.breakpoints || []).map(point => ({ id: point.line + 1000, verified: true, line: point.line, source: args.source }));
        breakpoints.set(args.source?.path, points);
        for (const point of points) emit("breakpoint", { reason: "changed", breakpoint: point });
        return { breakpoints: copy(points) };
      }
      case "pause": paused("pause"); return {};
      case "continue": session.state = "attached"; emit("continued", { threadId: 1, allThreadsContinued: true }); emit("output", { category: "stdout", output: "[qa-main] Synthetic request continued successfully.\n" }); return { allThreadsContinued: true };
      case "next": case "stepIn": case "stepOut": line = line >= 12 ? 10 : line + 1; paused("step"); return {};
      default: throw new Error(`Unsupported synthetic debug command: ${body.command}`);
    }
  }
  throw new Error(`Unsupported synthetic endpoint: ${endpoint}`);
}

function renderServices() {
  if (session?.processId && session.state !== "terminated" && !services.processes.find(item => item.id === session.processId)?.running) {
    session.state = "terminated"; emit("terminated");
  }
  const host = document.querySelector("#fixture-services"); host.replaceChildren();
  const title = document.createElement("strong"); title.textContent = "Services mirror · in-memory"; host.append(title);
  for (const configuration of services.configurations) {
    const process = services.processes.find(item => item.configurationId === configuration.id);
    const row = document.createElement("div"), label = document.createElement("span"), stop = document.createElement("button");
    row.dataset.configuration = configuration.id;
    label.dataset.state = process?.status || "stopped";
    label.textContent = `${configuration.name}: ${process?.status || "stopped"}${process?.debug ? " · debug" : ""}`;
    stop.type = "button"; stop.textContent = "Stop in Services"; stop.setAttribute("aria-label", `Stop ${configuration.name} in Services`); stop.disabled = !process?.running;
    stop.addEventListener("click", async () => { await services.api(`/api/run-configurations/${configuration.id}/stop`, { method: "POST" }); await runControls.refresh(); });
    row.append(label, stop); host.append(row);
  }
  document.querySelector("#fixture-release-start").disabled = !services.pendingLaunch;
}
const runControls = createIdeRunControls({ api: mockApi,
  onChange: () => ide?.syncRunState(), onProcesses: () => renderServices(),
  onError: error => inform(error.message, true),
  beforeStart: ({ repository: sourceRepository }) => !ide?.isDirty(sourceRepository.id),
  onStarted: (process, context) => { if (context.mode === "debug" && repositoryId === context.repository.id) return ide.attachLaunchedDebug(process); },
});
const terminal = createRepositoryTerminal({ document, api: mockApi, getRepository: () => repository,
  notify: (message, type) => inform(message, type === "error"),
  onVisibilityChange: state => { if (terminalSlot) terminalSlot.hidden = !state.visible; ide?.syncTerminalState(state); },
});
ide = createRepositoryIde({ host: document.querySelector("#fixture-ide-host"), api: mockApi,
  onError: error => inform(error.message, true),
  getRunState: () => runControls.state,
  onRunAction: (mode, id) => id === repositoryId ? runControls.run(mode) : null,
  onRunSelect: (id, ownerId) => ownerId === repositoryId && runControls.select(id),
  onRunConfigure: () => inform("This fixture has saved in-memory Services configurations; no configuration file is modified."),
  onTerminalMount: (slot) => {
    if (!slot) terminal.minimize({ restoreFocus: false });
    terminalSlot = slot;
    terminal.mount(slot || document.body);
    if (slot) slot.hidden = !terminal.getState().visible;
  },
  onTerminalToggle: ({ repositoryId: id, returnFocus }) => {
    if (id !== repositoryId || !terminalSlot) return;
    if (terminal.getState().visible) terminal.minimize();
    else { terminalSlot.hidden = false; return terminal.open({ repositoryId: id, returnFocus }); }
  },
});
document.querySelector("#fixture-repository").addEventListener("change", async event => {
  terminal.minimize({ restoreFocus: false }); ide.deactivate();
  repository = services.repositories.find(item => item.id === event.target.value); repositoryId = repository.id;
  document.querySelector("#context-repo").textContent = repository.name;
  document.querySelector("#context-branch").textContent = repository.branch;
  session = null; events.length = 0; sequence = 0;
  runControls.setContext({ repository, configurations: services.configurations, processes: services.processes });
  await ide.activate(repository); await ide.openFile(sourcePath, 10, 5, { focus: false });
  ide.syncTerminalState(terminal.getState());
  inform(`Opened ${repository.name}. Its terminal remains closed until explicitly opened.`);
});
document.querySelector("#project-structure-toggle").addEventListener("click", () => inform("Project Structure alignment preview; this isolated fixture has no actual project to inspect."));
document.querySelector("#repository-chat-toggle").addEventListener("click", event => {
  chatVisible = !chatVisible; event.currentTarget.textContent = chatVisible ? "Hide AI chat" : "Show AI chat";
  document.querySelector("#fixture-chat").hidden = !chatVisible;
  event.currentTarget.setAttribute("aria-pressed", String(chatVisible));
  event.currentTarget.setAttribute("aria-expanded", String(chatVisible));
  ide.syncChatVisibility();
});
document.querySelector("#fixture-delay-start").addEventListener("change", event => services.delayNextStart(event.target.checked));
document.querySelector("#fixture-release-start").addEventListener("click", () => { services.releaseStart(); document.querySelector("#fixture-delay-start").checked = false; });
for (const [id, method] of [["terminal-clear", "clear"], ["terminal-restart", "restart"], ["terminal-minimize", "minimize"], ["terminal-close", "close"]]) document.querySelector(`#${id}`).addEventListener("click", () => void terminal[method]());
document.querySelector("#terminal-resizer").addEventListener("pointerdown", event => {
  if (!terminalSlot) return;
  event.preventDefault(); const handle = event.currentTarget, slot = terminalSlot;
  handle.setPointerCapture(event.pointerId);
  const startY = event.clientY, height = slot.getBoundingClientRect().height;
  const move = next => { const maximum = slot.parentElement.clientHeight * .45; slot.style.flexBasis = `${Math.max(Math.min(140, maximum), Math.min(maximum, height + startY - next.clientY))}px`; };
  const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
  handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
});
document.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.code !== "Backquote") return;
  event.preventDefault();
  if (terminal.getState().visible) terminal.minimize();
  else if (terminalSlot) { terminalSlot.hidden = false; void terminal.open({ repositoryId }); }
});
document.querySelector("#fixture-theme").addEventListener("click", event => {
  const light = document.documentElement.dataset.theme !== "light";
  document.documentElement.dataset.theme = light ? "light" : "dark"; event.currentTarget.textContent = light ? "Dark theme" : "Light theme";
});
document.querySelector("#fixture-width").addEventListener("click", event => {
  const workspace = document.querySelector("#fixture-workspace"), narrow = workspace.dataset.narrow !== "true";
  workspace.dataset.narrow = String(narrow); event.currentTarget.textContent = narrow ? "Full layout" : "Narrow layout";
});
document.querySelector("#fixture-target").addEventListener("change", async event => { targetMode = event.target.value; await ide.refreshDebug(); });
document.querySelector("#fixture-hit").addEventListener("click", () => { line = breakpoints.get(sourcePath)?.[0]?.line || 10; paused("breakpoint"); });
document.querySelector("#fixture-output").addEventListener("click", () => {
  if (!session) { inform("Attach to the synthetic debug target first."); return; }
  emit("output", { category: "stdout", output: "[http-worker-1] POST /reviews customer=qa-customer-42 rating=5\n" });
  emit("output", { category: "stderr", output: "[synthetic warning] This line tests stderr styling; there is no service failure.\n" });
  emit("output", { category: "console", output: "<script>Text is escaped, not executed.</script>\n" });
});
document.querySelector("#fixture-terminate").addEventListener("click", () => {
  if (!session) { inform("No synthetic session to end."); return; }
  session.state = "terminated"; emit("terminated");
});
try {
  runControls.setContext({ repository, configurations: services.configurations, processes: services.processes });
  renderServices();
  await ide.activate(repository);
  await ide.openFile(sourcePath, 10, 5, { focus: false });
  await ide.refreshDebug();
  inform("Ready. Run/Debug and terminal use production controllers with synthetic in-memory transport. Services mirrors the same process list; nothing executes.");
} catch (error) { inform(error.stack || error.message, true); }
