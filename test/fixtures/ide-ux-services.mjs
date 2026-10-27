// In-memory Services/terminal transport for the isolated IDE preview. It cannot
// spawn a process, open a socket, or execute terminal input.
export function createIdeUxServices({ onChange = () => {} } = {}) {
  const repositories = [
    { id: "isolated-ide-ux-preview", name: "Review service · synthetic", path: "/synthetic/review-service", branch: "feature/review-ux" },
    { id: "isolated-invoice-preview", name: "Invoice service · synthetic", path: "/synthetic/invoice-service", branch: "main" },
  ];
  const configurations = [
    { id: "synthetic-review-api", repositoryId: repositories[0].id, name: "Review API", executable: "./mvnw", args: ["spring-boot:run"], cwd: ".", port: 8080 },
    { id: "synthetic-review-worker", repositoryId: repositories[0].id, name: "Review worker", executable: "./mvnw", args: ["spring-boot:run", "-Dspring.profiles.active=worker"], cwd: ".", port: 8081 },
    { id: "synthetic-invoice-api", repositoryId: repositories[1].id, name: "Invoice API", executable: "./mvnw", args: ["spring-boot:run"], cwd: ".", port: 8090 },
  ];
  const copy = value => structuredClone(value);
  const processes = [], terminals = new Map(), calls = [];
  let processSequence = 0, terminalSequence = 0, delayNext = false, pending = null;
  const active = item => ["starting", "running", "stopping"].includes(item.status);
  function changed() { onChange(); }
  function terminalSnapshot(session, after = 0) { return copy({ ...session, chunks: session.chunks.filter(chunk => chunk.cursor > after) }); }
  const prompt = repository => `\x1b[36m➜ ${repository.path.split("/").at(-1)}\x1b[0m git:(\x1b[31m${repository.branch}\x1b[0m) `;
  async function api(raw, options = {}) {
    const url = new URL(raw, "http://synthetic.invalid"), body = options.body || {};
    calls.push({ path: url.pathname, method: options.method || "GET", body: copy(body) });
    if (url.pathname === "/api/processes" && !options.method) return copy(processes);
    const logs = /^\/api\/processes\/([^/]+)\/logs$/.exec(url.pathname);
    if (logs && !options.method) {
      const process = processes.find(item => item.id === decodeURIComponent(logs[1]));
      if (!process) throw new Error("Unknown synthetic process");
      const output = [
        { timestamp: "2026-09-20T05:56:41Z", stream: "system", line: "Synthetic run — no application was launched." },
        ...Array.from({ length: 30 }, (_, i) => ({ timestamp: "2026-09-20T05:56:42Z", stream: "stdout", line: `[INFO] ${process.name} log entry ${i + 1}` })),
        { timestamp: "2026-09-20T05:56:43Z", stream: "stderr", line: "Synthetic warning for copy verification." },
      ];
      return { cursor: output.length, oldestCursor: 0, dropped: 0, status: process.status, logs: output.slice(Number(url.searchParams.get("after")) || 0) };
    }
    const run = /^\/api\/run-configurations\/([^/]+)\/(start|stop)$/.exec(url.pathname);
    if (run && options.method === "POST") {
      const configuration = configurations.find(item => item.id === decodeURIComponent(run[1]));
      if (!configuration) throw new Error("Unknown synthetic Services configuration");
      if (run[2] === "stop") {
        for (const item of processes) if (item.configurationId === configuration.id && active(item)) {
          item.status = "stopped"; item.running = false; if (item.debug) item.debug.state = "stopped";
        }
        changed(); return { ok: true };
      }
      if (processes.some(item => item.configurationId === configuration.id && active(item))) throw new Error("Synthetic service is already running");
      if (delayNext) {
        if (pending) throw new Error("Another synthetic delayed launch is pending");
        delayNext = false;
        await new Promise(resolve => { pending = { configurationId: configuration.id, resolve }; changed(); });
      }
      const process = { id: `synthetic-process-${++processSequence}`, configurationId: configuration.id, repositoryId: configuration.repositoryId,
        name: configuration.name, startedAt: new Date().toISOString(), status: "running", running: true,
        ...(body.debug ? { debug: { runtime: "java", host: "127.0.0.1", port: 5505 + configurations.indexOf(configuration), state: "listening" } } : {}),
      };
      processes.unshift(process); changed(); return copy(process);
    }
    const terminal = /^\/api\/repositories\/([^/]+)\/terminal(\/[^/]+)?$/.exec(url.pathname);
    if (terminal) {
      const repository = repositories.find(item => item.id === decodeURIComponent(terminal[1]));
      if (!repository) throw new Error("Unknown synthetic terminal repository");
      let session = terminals.get(repository.id);
      const action = terminal[2] || "";
      if (!action) return session ? terminalSnapshot(session, Number(url.searchParams.get("after")) || 0) : { running: false, chunks: [] };
      if (options.method !== "POST") throw new Error("Synthetic terminal mutation requires POST");
      if (action === "/start") {
        if (!session?.running) {
          session = { id: `synthetic-terminal-${++terminalSequence}`, repositoryId: repository.id, pty: true, shell: "/bin/zsh", cwd: repository.path, running: true, cursor: 1,
            chunks: [{ cursor: 1, data: `ISOLATED QA: synthetic terminal output; no shell was launched.\r\n${prompt(repository)}` }] };
          terminals.set(repository.id, session);
        }
        return terminalSnapshot(session);
      }
      if (!session || body.sessionId !== session.id) throw new Error("Synthetic terminal session mismatch");
      if (action === "/stop") session.running = false;
      else if (action === "/clear") session.chunks = [];
      else if (action === "/resize") { session.cols = body.cols; session.rows = body.rows; }
      else if (action === "/input") session.chunks.push({ cursor: ++session.cursor, data: `\r\n[Synthetic input was not executed]\r\n${prompt(repository)}` });
      else throw new Error("Unsupported synthetic terminal action");
      return terminalSnapshot(session);
    }
    throw new Error("Not a synthetic Services/terminal request");
  }
  return { repositories, configurations, api,
    get processes() { return copy(processes); }, get calls() { return copy(calls); },
    get pendingLaunch() { return pending?.configurationId || null; },
    delayNextStart(value = true) { delayNext = Boolean(value); },
    releaseStart() { if (!pending) return false; const next = pending; pending = null; next.resolve(); changed(); return true; },
  };
}
