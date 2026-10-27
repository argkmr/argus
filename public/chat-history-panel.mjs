// Repository history belongs to the chat; Nexus keeps its original sidebar.
export function installChatHistoryPanels({ document, toggle }) {
  // Stack the existing controls in DOM order: removed activities leave no slots.
  const menu = document.querySelector('#app-menu');
  if (menu && !document.querySelector('.workspace-activity-stack')) {
    const rail = document.createElement('nav');
    rail.className = 'workspace-activity-stack'; rail.setAttribute('aria-label', 'Workspace navigation');
    document.body.append(rail);
    rail.append(menu);
    for (const id of ['agents-toggle', 'daily-planner-toggle', 'diagram-studio-rail-toggle']) {
      const control = document.getElementById(id);
      if (control) rail.append(control);
    }
  }
  const icon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 11a9 9 0 1 1 3 7M3 4v7h7M12 7v5l3 2"/></svg>';
  for (const scope of ['repository']) {
    const panel = document.querySelector(scope === 'repository' ? '#repository-task-sidebar' : '#global-context-sidebar');
    const header = document.querySelector(scope === 'repository' ? '#repository-ai-chat .ai-sticky-header' : '.global-codex-header-row');
    if (!panel || !header) continue;
    const button = document.createElement('button');
    button.id = `${scope}-chat-history-toggle`; button.type = 'button'; button.className = 'chat-history-toggle';
    button.title = 'Task history'; button.setAttribute('aria-label', 'Open task history');
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', panel.id); button.innerHTML = icon;
    panel.setAttribute('popover', 'auto'); panel.classList.add('chat-history-popover');
    panel.querySelector('.task-panel-rail')?.remove();
    panel.inert = false;
    header.append(button, panel);
    const position = () => {
      const bounds = button.getBoundingClientRect();
      const view = document.defaultView;
      panel.style.setProperty('--history-top', Math.max(8, Math.min(bounds.bottom + 6, view.innerHeight - 160)) + 'px');
      panel.style.setProperty('--history-right', Math.max(8, view.innerWidth - Math.min(view.innerWidth - 8, bounds.left + 360)) + 'px');
    };
    button.addEventListener('click', () => { position(); toggle(scope, !panel.matches(':popover-open')); });
    document.defaultView.addEventListener('resize', position);
    panel.addEventListener('toggle', event => {
      const open = event.newState === 'open'; button.setAttribute('aria-expanded', String(open));
      if (!open) toggle(scope, false);
    });
    document.querySelector(scope === 'repository' ? '#repository-task-resizer' : '#global-task-resizer')?.remove();
  }
}
