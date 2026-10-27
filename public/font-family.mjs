// System font stacks keep this preference offline and avoid redistributing fonts.
export const DEFAULT_FONT_FAMILY = 'system';
export const FONT_FAMILY_CACHE_KEY = 'argus-font-family';
export const FONT_FAMILIES = Object.freeze([
  Object.freeze({ id: 'system', label: 'System', stack: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }),
  Object.freeze({ id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' }),
  Object.freeze({ id: 'mono', label: 'Mono', stack: 'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, monospace' }),
  Object.freeze({ id: 'comic-sans', label: 'Comic Sans', stack: '"Comic Sans MS", "Chalkboard SE", cursive' }),
]);

export function normalizeFontFamily(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return FONT_FAMILIES.some(font => font.id === id) ? id : DEFAULT_FONT_FAMILY;
}

// Chromium storage is a first-paint cache; Java preferences are authoritative.
// One writer prevents an older, slower PATCH from overwriting the latest choice.
export function createFontFamilyPreference({ storage, save, onChange = () => {}, onStatus = () => {} }) {
  let cached;
  try { cached = storage?.getItem(FONT_FAMILY_CACHE_KEY); } catch { /* Storage may be blocked. */ }
  let selected = normalizeFontFamily(cached);
  let revision = 0;
  let writes = Promise.resolve();
  const cache = () => {
    try { storage?.setItem(FONT_FAMILY_CACHE_KEY, selected); } catch { /* Java persistence still works. */ }
  };
  const paint = () => onChange(selected);

  function select(value) {
    selected = normalizeFontFamily(value);
    const id = selected;
    const requestRevision = ++revision;
    cache();
    paint();
    onStatus('saving');
    writes = writes.then(async () => {
      // Coalesce queued intermediate choices, but await any write already sent.
      if (requestRevision !== revision) return false;
      try {
        await save(id);
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
    get selected() { return selected; },
    select,
    retry: () => select(selected),
    restore(value) {
      // A workspace response begun before a user click must not undo that click.
      if (revision) { paint(); return; }
      selected = normalizeFontFamily(value);
      cache();
      paint();
      onStatus('ready');
    },
  };
}

export function initializeFontFamilyPicker({ document, storage, save }) {
  const select = document.querySelector('#font-family-select');
  const status = document.querySelector('#font-family-status');
  const retry = document.querySelector('#font-family-retry');
  const preview = document.querySelector('#font-family-preview');
  function render(id) {
    const font = FONT_FAMILIES.find(item => item.id === id);
    document.documentElement.dataset.fontFamily = id;
    if (select) select.value = id;
    if (preview) {
      preview.textContent = 'Aa';
      preview.title = `${font.label} font preview`;
    }
  }
  function renderStatus(value) {
    if (status) {
      status.dataset.state = value;
      status.textContent = value === 'saving' ? 'Saving font…'
        : value === 'saved' ? 'Font saved. Code stays monospace.'
          : value === 'error' ? 'Could not save font. Preview is still applied.'
            : 'Applies to Argus. Code stays monospace.';
    }
    if (retry) retry.hidden = value !== 'error';
  }
  const preference = createFontFamilyPreference({ storage, save, onChange: render, onStatus: renderStatus });
  render(preference.selected);
  renderStatus('ready');
  select?.addEventListener('change', () => { void preference.select(select.value); });
  retry?.addEventListener('click', () => { void preference.retry(); });
  return preference;
}
