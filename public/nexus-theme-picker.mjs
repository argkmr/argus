import { NEXUS_THEMES, normalizeNexusTheme, nexusThemeChoices, nexusThemeVariables } from './nexus-themes.mjs?v=20261027-404';

const CACHE_KEY = 'argus-nexus-theme';
const MODE_CACHE_KEY = 'argus-nexus-themes';

export function normalizeNexusThemePreferences(value) {
  // A legacy saved string is meaningful in both appearances. New installations
  // start with the two user-approved defaults; partial/new settings stay safe.
  if (typeof value === 'string' && value.trim()) {
    const id = normalizeNexusTheme(value);
    return { dark: id, light: id };
  }
  return {
    dark: value && typeof value === 'object' && Object.hasOwn(value, 'dark') ? normalizeNexusTheme(value.dark) : 'ocean',
    light: value && typeof value === 'object' && Object.hasOwn(value, 'light') ? normalizeNexusTheme(value.light) : 'midnight',
  };
}

// DOM rectangles are zoomed pixels; CSS offsets inside the scaled body are not.
export function nexusThemePopoverPosition(anchor, size, viewport, scale = 1) {
  return {
    left: Math.max(12, Math.min(anchor.left, viewport.width - size.width - 12)) / scale,
    top: Math.max(12, Math.min(anchor.bottom + 10, viewport.height - size.height - 12)) / scale,
  };
}

// One writer: a slow earlier PATCH must finish before the latest choice is saved.
// A successful workspace load is authoritative over Chromium's paint cache.
export function createNexusThemePreference({ storage, save, getMode = () => 'dark', onChange = () => {}, onStatus = () => {} }) {
  let cached;
  try {
    const modes = storage?.getItem(MODE_CACHE_KEY);
    if (modes) { try { cached = JSON.parse(modes); } catch { /* Fall back to the old paint cache. */ } }
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) cached = storage?.getItem(CACHE_KEY);
  } catch { /* Storage can be unavailable. */ }
  let selected = normalizeNexusThemePreferences(cached), revision = 0, writes = Promise.resolve();
  const mode = () => getMode() === 'light' ? 'light' : 'dark';
  const cache = () => {
    try {
      storage?.setItem(MODE_CACHE_KEY, JSON.stringify(selected));
      storage?.setItem(CACHE_KEY, selected[mode()]);
    } catch { /* Java persistence remains available. */ }
  };
  const paint = () => { onChange(selected[mode()], { ...selected }); };
  function select(value) {
    selected = { ...selected, [mode()]: normalizeNexusTheme(value) };
    const id = selected[mode()], snapshot = { ...selected }, requestRevision = ++revision;
    cache(); paint(); onStatus('saving');
    writes = writes.then(async () => {
      if (requestRevision !== revision) return false;
      try {
        await save(id, snapshot);
        if (requestRevision === revision) onStatus('saved');
        return true;
      } catch {
        if (requestRevision === revision) onStatus('error');
        return false;
      }
    });
    return writes;
  }
  return {
    get selected() { return selected[mode()]; },
    get selections() { return { ...selected }; },
    select,
    retry: () => select(selected[mode()]),
    refreshAppearance() { cache(); paint(); },
    restore(value) {
      if (revision) { paint(); return; } // Also reconcile local preferences after a delayed workspace GET.
      selected = normalizeNexusThemePreferences(value);
      cache(); paint(); onStatus('ready');
    },
  };
}

export function initializeNexusThemePicker({ document, storage, save, onSelect = () => {}, setAppearance }) {
  const panel = document.querySelector('#global-codex-panel');
  const shortcut = document.querySelector('#nexus-shortcut');
  const toggle = document.querySelector('#nexus-theme-toggle');
  const chooser = document.querySelector('#nexus-theme-picker');
  const grid = chooser.querySelector('.nexus-theme-options');
  const label = document.querySelector('#nexus-theme-label');
  const status = chooser.querySelector('[data-theme-save-status]');
  const retry = chooser.querySelector('[data-theme-retry]');
  const mode = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  let preference;
  function render(id) {
    const choices = nexusThemeChoices(mode());
    const theme = choices.find(item => item.id === id);
    for (const element of [panel, shortcut]) {
      element.dataset.nexusTheme = id;
      for (const [name, value] of Object.entries(nexusThemeVariables(id, mode()))) element.style.setProperty(name, value);
    }
    label.textContent = theme.label;
    toggle.title = `Nexus theme: ${theme.label}. Choose from ${choices.length} ${mode()} themes.`;
    grid.setAttribute('aria-label', `Choose one of ${choices.length} ${mode()} Nexus themes`);
    for (const button of grid.querySelectorAll('[data-nexus-theme-choice]')) {
      const option = choices.find(item => item.id === button.dataset.nexusThemeChoice);
      const palette = option.palette;
      button.setAttribute('aria-pressed', String(option.id === id));
      button.setAttribute('aria-label', `${option.label} theme`);
      button.title = option.description;
      button.querySelector('.nexus-theme-name').textContent = option.label;
      button.querySelector('.nexus-theme-description').textContent = option.description;
      button.querySelector('.nexus-theme-check').textContent = option.id === id ? '✓' : '';
      for (const key of ['bg', 'text', 'accent', 'line']) button.style.setProperty(`--choice-${key}`, palette[key]);
      for (const [index, key] of ['bg', 'surface-2', 'accent'].entries()) button.querySelectorAll('.nexus-theme-swatch')[index].style.backgroundColor = palette[key];
    }
    for (const button of chooser.querySelectorAll('[data-nexus-appearance]')) button.setAttribute('aria-pressed', String(button.dataset.nexusAppearance === mode()));
  }
  for (const theme of NEXUS_THEMES) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.nexusThemeChoice = theme.id;
    button.title = theme.description; button.setAttribute('aria-label', `${theme.label} theme`);
    const swatches = document.createElement('span'); swatches.className = 'nexus-theme-swatches'; swatches.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) { const swatch = document.createElement('span'); swatch.className = 'nexus-theme-swatch'; swatches.append(swatch); }
    const name = document.createElement('span'); name.className = 'nexus-theme-name';
    const description = document.createElement('small'); description.className = 'nexus-theme-description';
    const check = document.createElement('span'); check.className = 'nexus-theme-check'; check.setAttribute('aria-hidden', 'true');
    button.append(swatches, name, check, description);
    button.addEventListener('click', () => { void preference.select(theme.id); });
    grid.append(button);
  }
  preference = createNexusThemePreference({ storage, save, getMode: mode, onChange(id, selections) { render(id); onSelect(id, selections); }, onStatus(value) {
    status.textContent = value === 'saving' ? 'Saving…' : value === 'saved' ? 'Saved for Nexus. Dark and light choices are remembered separately.' : value === 'error' ? 'Could not save. Your preview is still applied.' : '6 dark + 6 light themes. Your choice is remembered separately for each appearance.';
    retry.hidden = value !== 'error';
  } });
  render(preference.selected);
  const position = () => {
    if (!chooser.matches(':popover-open')) return;
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const scale = chooser.getBoundingClientRect().width / chooser.offsetWidth || 1;
    chooser.style.maxHeight = `${Math.max(1, viewport.height - 24) / scale}px`;
    chooser.style.maxWidth = `${Math.max(1, viewport.width - 24) / scale}px`;
    const offsets = nexusThemePopoverPosition(toggle.getBoundingClientRect(), chooser.getBoundingClientRect(), viewport, scale);
    chooser.style.left = `${offsets.left}px`;
    chooser.style.top = `${offsets.top}px`;
  };
  chooser.addEventListener('toggle', () => { toggle.setAttribute('aria-expanded', String(chooser.matches(':popover-open'))); position(); });
  chooser.querySelector('[data-theme-close]').addEventListener('click', () => { chooser.hidePopover(); toggle.focus(); });
  retry.addEventListener('click', () => { void preference.retry(); });
  for (const button of chooser.querySelectorAll('[data-nexus-appearance]')) button.addEventListener('click', () => setAppearance(button.dataset.nexusAppearance));
  const Observer = document.defaultView.MutationObserver;
  new Observer(() => preference.refreshAppearance()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new Observer(() => { if (document.body.dataset.view !== 'global' && chooser.matches(':popover-open')) chooser.hidePopover(); }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  document.defaultView.addEventListener('resize', position);
  new document.defaultView.ResizeObserver(position).observe(chooser);
  return preference;
}
