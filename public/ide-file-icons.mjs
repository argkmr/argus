// Decorative, locally bundled geometry; file names never become SVG markup.
const shapes = {
  folder: '<path class="ide-folder-closed" d="M2.5 6.5h5l1.8 2H21v10.3a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7Z"/><path class="ide-folder-open" d="M3 10V6.5h5l1.8 2H20V11M2.5 11.5h19l-2 9H4.5Z"/>',
  file: '<path d="M5 3.5h9l5 5v12H5Z"/><path d="M14 3.5v5h5M8 13h8M8 16.5h6"/>',
  code: '<path d="M8 8 3 12l5 4m8-8 5 4-5 4M13 6l-2 12"/>',
  java: '<path d="M6 10h10v5a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4Zm10 1h2a2 2 0 0 1 0 4h-2M5 22h13M10 7c-4-3 4-3 1-6M14 7c-3-2 3-3 2-5"/>',
  javascript: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M10 9v7a2 2 0 0 1-4 0m11-6c-4-3-6 2-2 3 4 1 2 6-2 3"/>',
  typescript: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M5.5 9h6M8.5 9v9m10-8c-4-3-6 2-2 3 4 1 2 6-2 3"/>',
  python: '<path d="M5 12V7a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v5H9m10 0v5a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3v-5h8M5 8H3v8h4m10-8h4v8h-2"/><path d="M9 7h.01M15 17h.01"/>',
  data: '<path d="M9 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2m6-16h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2"/><path d="M11 9h2m-2 6h2"/>',
  config: '<path d="M4 6h16M4 12h16M4 18h16"/><rect x="7" y="4" width="3" height="4" rx="1"/><rect x="14" y="10" width="3" height="4" rx="1"/><rect x="8" y="16" width="3" height="4" rx="1"/>',
  package: '<path d="m12 2 9 5v10l-9 5-9-5V7Zm-9 5 9 5 9-5M12 12v10M7.5 4.5l9 5V13"/>',
  container: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 10v7m5-7v7m5-7v7M8 7V3h8v4"/>',
  git: '<path d="m12 2 10 10-10 10L2 12Z"/><circle cx="9" cy="7" r="1.5"/><circle cx="9" cy="16" r="1.5"/><circle cx="16" cy="12" r="1.5"/><path d="M9 8.5v6M10.5 7.5l4 3.5"/>',
  markdown: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 15V9l3 3 3-3v6m4-3 3 3 3-3M18 9v6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m4 18 5-5 3 3 4-5 5 6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
};

export function describeIdeFileIcon({ name = "", path = "", directory = false } = {}) {
  const file = String(name || String(path || "").split("/").pop()).toLowerCase();
  if (directory) return { kind: "folder", tone: /^(src|source|app|lib|packages|components)$/.test(file) ? "source" : /^(test|tests|__tests__|spec|specs)$/.test(file) ? "test" : /^(node_modules|vendor|build|dist|target|\.gradle.*|\.next)$/.test(file) ? "muted" : "folder" };
  if (/\.java$/.test(file)) return { kind: "java", tone: "warm" };
  if (/\.(ts|tsx|mts|cts)$/.test(file)) return { kind: "typescript", tone: "source" };
  if (/\.(js|jsx|mjs|cjs)$/.test(file)) return { kind: "javascript", tone: "warm" };
  if (/\.(py|pyi|pyw)$/.test(file)) return { kind: "python", tone: "source" };
  if (/^dockerfile(?:\.|-|$)|^compose\.ya?ml$|^docker-compose/.test(file)) return { kind: "container", tone: "source" };
  if (/^\.git/.test(file)) return { kind: "git", tone: "warm" };
  if (/^(package(?:-lock)?\.json|pom\.xml|.*\.gradle(?:\.kts)?|yarn\.lock|pnpm-lock\.yaml|cargo\.(toml|lock)|go\.(mod|sum))$/.test(file)) return { kind: "package", tone: "test" };
  if (/\.(json|jsonc|json5|xml|csv|sql)$/.test(file)) return { kind: "data", tone: "warm" };
  if (/\.(md|mdx|markdown|rst)$/.test(file)) return { kind: "markdown", tone: "source" };
  if (/\.(png|jpe?g|gif|svg|webp|ico|avif)$/.test(file)) return { kind: "image", tone: "test" };
  if (/\.(sh|bash|zsh|bat|cmd|ps1)$|^(gradlew|mvnw|jenkinsfile|prodjenkinsfile)$/.test(file)) return { kind: "terminal", tone: "test" };
  if (/\.(ya?ml|toml|ini|properties|conf|config)$|^\.env(?:\.|$)|^\.?(?:editorconfig|prettierrc|eslintrc)/.test(file)) return { kind: "config", tone: "muted" };
  if (/\.(kt|kts|go|rs|rb|c|h|cpp|hpp|cs|swift|php|html|css|scss|vue|svelte)$/.test(file)) return { kind: "code", tone: "source" };
  return { kind: "file", tone: "muted" };
}

export function createIdeFileIcon(doc, entry) {
  const { kind, tone } = describeIdeFileIcon(entry);
  const icon = doc.createElement("span");
  icon.className = "repository-ide-file-icon";
  icon.dataset.kind = kind; icon.dataset.tone = tone;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false">${shapes[kind]}</svg>`;
  return icon;
}
