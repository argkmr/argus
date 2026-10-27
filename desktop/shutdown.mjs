export async function stopChild(child, { gracefulMs = 2_000, forceMs = 1_000 } = {}) {
  const exited = () => !child || child.exitCode != null || child.signalCode != null;
  if (exited()) return;
  const wait = (duration) => new Promise((resolve) => {
    let timer;
    const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
    child.once("exit", finish);
    timer = setTimeout(finish, duration);
    if (exited()) finish();
  });
  // Register first: a fast child can exit synchronously in tests or before the
  // next turn of the event loop in production.
  let waiting = wait(gracefulMs);
  try { child.kill("SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await waiting;
  if (!exited()) {
    waiting = wait(forceMs);
    try { child.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await waiting;
  }
  if (!exited()) throw new Error("Java backend did not exit; data cleanup was cancelled");
}

/** Stop only the exact JVM recorded by this installation, and wait before reusing its port. */
export async function stopRecordedJava(record, { readCommand, signal, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 60_000 }) {
  const pid = Number(record?.pid);
  const jar = String(record?.jar || "");
  if (!Number.isInteger(pid) || pid <= 1 || !jar.startsWith("/") || !/\/argus-backend(?:-[\w.-]+)?\.jar$/.test(jar)) return;
  const original = readCommand(pid).trim();
  if (!original.includes(`-jar ${jar}`)) return;
  try { signal(pid, "SIGTERM"); } catch (error) { if (error.code === "ESRCH") return; throw error; }
  const deadline = now() + timeoutMs;
  while (readCommand(pid).trim() === original) {
    if (now() >= deadline) throw new Error("The previous Argus Java backend is still shutting down. Wait and reopen Argus; its data was not modified.");
    await sleep(100);
  }
}

/** Electron requests Java's full producer/storage drain before stopping the JVM. */
export async function drainJavaBackend({ child, baseUrl, token, fetchImpl = fetch, stopImpl = stopChild }) {
  const exited = () => !child || child.exitCode != null || child.signalCode != null;
  if (exited()) return;
  if (!token) throw new Error("Java shutdown authorization is missing; data cleanup was cancelled");
  try {
    const response = await fetchImpl(`${baseUrl}/api/internal/maintenance/shutdown`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(90_000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Java background work did not drain; data cleanup was cancelled");
  } catch (error) {
    if (!exited()) throw error;
  }
  await stopImpl(child, { gracefulMs: 30_000, forceMs: 2_000 });
}
