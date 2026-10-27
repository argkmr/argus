// Local, decorative line icons. Accessible names belong to the surrounding control.
const paths = {
  files: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5.5 8h1M5.5 12h1"/>',
  branch: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M6 7.5v9M18 7.5v1a6 6 0 0 1-6 6H6"/>',
  chat: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  left: '<path d="m11 5-7 7 7 7M4 12h16"/>',
  right: '<path d="m13 5 7 7-7 7M4 12h16"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  save: '<path d="M4 3h13l4 4v14H3V3Zm3 0v6h10V3M7 21v-8h10v8"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
  bug: '<rect x="7" y="6" width="10" height="14" rx="5"/><path d="M9 6V4h6v2M3 9h4m10 0h4M3 14h4m10 0h4M5 21l3-3m8 0 3 3M12 7v13"/>',
  play: '<path d="m7 4 13 8-13 8Z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  'step-over': '<path d="M4 12a8 8 0 0 1 16 0m-5-4 5 4 2-5"/><circle cx="12" cy="18" r="2"/>',
  'step-into': '<path d="M12 3v11m-5-5 5 5 5-5"/><circle cx="12" cy="20" r="1"/>',
  'step-out': '<path d="M12 15V4m-5 5 5-5 5 5"/><circle cx="12" cy="20" r="1"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 1 7M20 3v5h-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  logs: '<path d="M4 5h16M4 10h16M4 15h10M4 20h10"/>',
  maximize: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  minimize: '<path d="M5 12h14"/>',
  collapse: '<rect x="7" y="7" width="14" height="14" rx="2"/><path d="M17 7V3H3v14h4m3-3h8"/>',
};

export function createIdeIcon(doc, name) {
  const icon = doc.createElement("span");
  icon.className = "repository-ide-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths[name] || paths.code}</svg>`;
  return icon;
}
