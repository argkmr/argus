/** Coalesce safe reads, but never share a caller-owned cancellation signal. */
export function createApiClient(fetcher = globalThis.fetch, { onMutation = () => {} } = {}) {
  const pending = new Map();
  return async function api(path, options = {}) {
    const { dedupe = true, timeout: suppliedTimeout, signal, body, ...fetchOptions } = options;
    const method = String(options.method || "GET").toUpperCase();
    const key = method === "GET" && dedupe && !signal ? path : "";
    if (key && pending.has(key)) return pending.get(key);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
    const notify = phase => { if (mutating) { try { onMutation({ path, method, phase }); } catch { /* Observers cannot change a request's outcome. */ } } };
    notify("started");
    const operation = (async () => {
      const controller = new AbortController();
      const timeout = suppliedTimeout ?? (method === "GET" ? 20_000 : 120_000);
      const abort = () => controller.abort(signal.reason);
      let timedOut = false;
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      const timer = timeout > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
      try {
        const response = await fetcher(path, {
          ...fetchOptions, method, signal: controller.signal,
          headers: { "content-type": "application/json", ...(options.headers || {}) },
          body: body && typeof body !== "string" ? JSON.stringify(body) : body,
        });
        const payload = await response.json().catch(error => {
          if (controller.signal.aborted) throw error;
          return {};
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status})`), { status: response.status });
        return payload;
      } catch (error) {
        if (timedOut) throw new Error("Argus took too long to respond. Please retry.");
        throw error;
      } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); notify("settled"); }
    })();
    if (key) pending.set(key, operation);
    try { return await operation; } finally { if (key && pending.get(key) === operation) pending.delete(key); }
  };
}
