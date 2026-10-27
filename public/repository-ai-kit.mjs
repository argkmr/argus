// Explicit controls. Merely opening a repository only reads local job status.
export function createRepositoryAiKit({ document, api, getRepository, onError }) {
  const host = document.createElement('details');
  host.className = 'repository-ai-kit';
  host.innerHTML = '<summary title="Manage private repository AI kit">AI kit <span data-kit-label>Not started</span></summary><section><strong>Repository AI kit</strong><p data-kit-status>Start when you want Argus to map this repository.</p><div><button type="button" data-kit-action="start">Start</button><button type="button" data-kit-action="pause">Pause</button><button type="button" data-kit-action="resume">Resume</button><button type="button" data-kit-action="restart">Restart from scratch</button></div><small>Restart clears this repository’s private generated kit and starts again. Your code and chats stay intact.</small></section>';
  document.querySelector('.context-strip').append(host);
  let sequence = 0, busy = false, lastRepository = '', timer;
  const buttons = [...host.querySelectorAll('[data-kit-action]')];
  async function refresh() {
    const repository = getRepository();
    host.hidden = !repository;
    if (!repository || busy) return;
    const revision = ++sequence;
    try {
      const result = await api(`/api/repositories/${encodeURIComponent(repository.id)}/ai-kit`);
      if (revision !== sequence || getRepository()?.id !== repository.id) return;
      lastRepository = repository.id;
      const job = result.job, active = ['queued', 'running', 'paused'].includes(job?.status);
      host.querySelector('[data-kit-label]').textContent = active ? job.status : result.ready ? 'Ready' : job?.status || 'Not started';
      host.querySelector('[data-kit-status]').textContent = job?.error || job?.message || 'Start when you want Argus to map this repository. No automatic AI requests.';
      for (const button of buttons) {
        const action = button.dataset.kitAction;
        button.disabled = action === 'pause' ? !active || job.status === 'paused'
          : action === 'resume' ? job?.status !== 'paused' : action === 'start' ? active : false;
      }
    } catch (error) {
      if (revision === sequence) host.querySelector('[data-kit-status]').textContent = error.message;
    }
  }
  host.addEventListener('click', async event => {
    const button = event.target.closest('[data-kit-action]'), repository = getRepository();
    if (!button || !repository || busy) return;
    const action = button.dataset.kitAction;
    if (action === 'restart' && !document.defaultView.confirm(`Restart the AI kit for ${repository.name} from scratch? This clears only its private generated kit.`)) return;
    busy = true; ++sequence; buttons.forEach(item => { item.disabled = true; });
    try { await api(`/api/repositories/${encodeURIComponent(repository.id)}/ai-kit/${action}`, { method: 'POST', timeout: 0 }); }
    catch (error) { onError(error); }
    finally { busy = false; void refresh(); }
  });
  host.addEventListener('toggle', () => { if (host.open) void refresh(); });
  timer = setInterval(() => {
    if (host.open || getRepository()?.id !== lastRepository) void refresh();
  }, 2500);
  void refresh();
  return { refresh, dispose() { clearInterval(timer); sequence++; host.remove(); } };
}
