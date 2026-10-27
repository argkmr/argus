/** Coordinates draft consent before native shutdown; never drains after a cancelled prompt. */
export function createEditorExitGuard({ readDirty, confirmDiscard, confirmPreventedUnload,
  setQuitting, setWindowEnabled, drain, exit, onFailure }) {
  let inFlight;

  async function confirmDraftLoss(action) {
    let dirty, checkFailed = false;
    try { dirty = await readDirty(); }
    catch { dirty = true; checkFailed = true; }
    return !dirty || await confirmDiscard({ action, checkFailed });
  }

  function requestQuit(options = {}) {
    if (inFlight) return inFlight;
    const operation = (async () => {
      try {
        if (!await confirmDraftLoss("quit")) return false;
        setQuitting(true);
        setWindowEnabled(false);
        await drain();
        exit(options);
        return true;
      } catch (error) {
        setQuitting(false);
        setWindowEnabled(true);
        onFailure(error);
        return false;
      }
    })();
    inFlight = operation.finally(() => { inFlight = undefined; });
    return inFlight;
  }

  function handlePreventedUnload(event) {
    // A quit prompt or drain already owns the decision. Do not show another prompt.
    if (inFlight) return false;
    if (!confirmPreventedUnload()) return false;
    // Electron intentionally uses preventDefault here to override the renderer's veto.
    event.preventDefault();
    return true;
  }

  return { requestQuit, confirmDraftLoss, handlePreventedUnload };
}
