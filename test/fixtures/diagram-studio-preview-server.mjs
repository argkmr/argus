// Opt-in visual QA fixture. Serves only frontend/out and synthetic in-memory API
// data. It never starts Argus/Java/Electron, reads a profile, forwards a request,
// executes a command, or writes diagram data to disk. Restart clears every edit.
// Build separately, then: node test/fixtures/diagram-studio-preview-server.mjs
// Optional: ARGUS_DIAGRAM_PREVIEW_PORT=4189 (0 selects a free port).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const exportedRoot = path.resolve(path.dirname(here), '../../frontend/out');
const MAX_BYTES = 10_000_000;
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};
const emptyArrayRoutes = new Set([
  '/api/agents/providers', '/api/agents/jobs', '/api/background-jobs', '/api/processes',
  '/api/integrations/bitbucket', '/api/integrations/slack', '/api/orchestration/profiles', '/api/orchestration/runs',
  '/api/api-environments', '/api/api-request-history',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (status, message) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
const summary = ({ snapshot, ...document }) => document;

function send(response, status, value, head = false) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(head ? undefined : body);
}

async function body(request) {
  if (Number(request.headers['content-length'] || 0) > MAX_BYTES) throw failure(413, 'Preview request exceeds 10 MB');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw failure(413, 'Preview request exceeds 10 MB');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'Invalid JSON request'); }
  if (!object(value)) throw failure(400, 'Expected a JSON object');
  return value;
}

function snapshotRequest(value) {
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 160) throw failure(400, 'Choose a board name up to 160 characters');
  const snapshot = value.snapshot;
  if (!object(snapshot) || !object(snapshot.structured) || !object(snapshot.sketch)) throw failure(400, 'Both canvas snapshots are required');
  if (!Array.isArray(snapshot.structured.nodes) || snapshot.structured.nodes.length > 2000
      || !Array.isArray(snapshot.structured.edges) || snapshot.structured.edges.length > 5000
      || !object(snapshot.structured.viewport) || !Array.isArray(snapshot.sketch.elements) || snapshot.sketch.elements.length > 10000
      || !object(snapshot.sketch.appState) || !object(snapshot.sketch.files) || !Array.isArray(snapshot.sketch.libraryItems)) {
    throw failure(400, 'Invalid or oversized preview canvas');
  }
  return { name: value.name.trim(), snapshot: clone(snapshot) };
}

/** Importing this module creates no listener. assetRoot is injectable only for synthetic tests. */
export function createDiagramStudioPreviewServer({ assetRoot = exportedRoot } = {}) {
  const documents = new Map();
  let preferences = { theme: 'dark', fontSize: 'comfortable', fontFamily: 'system', repositoryTabGroups: [], repositoryTabOrder: [], serviceCardOrder: [] };
  const workspace = () => ({ repositories: [], activeRepositoryId: null, runConfigurations: [], preferences: clone(preferences) });
  const revisionMatches = (document, revision) => {
    if (!Number.isSafeInteger(revision) || revision !== document.revision) throw failure(409, 'This preview board changed. Your draft has been preserved.');
  };
  const save = document => {
    if (Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) throw failure(413, 'Preview board exceeds 10 MB');
    documents.set(document.id, clone(document));
    return document;
  };
  return http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Argus-Preview', 'synthetic-memory-only');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = request.socket.localPort;
      if (!new RegExp(`^(?:127\\.0\\.0\\.1|localhost):${port}$`, 'i').test(request.headers.host || '')) throw failure(403, 'Loopback preview hosts only');
      const origin = request.headers.origin;
      if (origin && !new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${port}$`, 'i').test(origin)) throw failure(403, 'Preview accepts same-origin requests only');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Preview blocks cross-site requests');
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname), method = request.method;
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) throw failure(400, 'Invalid preview path');
      if (pathname === '/api/workspace' && method === 'GET') return send(response, 200, workspace());
      if (pathname === '/api/backup/access' && method === 'GET') return send(response, 200, { allowed: false });
      if (pathname === '/api/preferences' && method === 'PATCH') {
        const patch = await body(request);
        preferences = { ...preferences, ...patch };
        return send(response, 200, clone(preferences));
      }
      if (method === 'GET' && (emptyArrayRoutes.has(pathname)
          || /^\/api\/repositories\/[^/]+\/api-(?:requests|collections)$/.test(pathname))) return send(response, 200, []);
      if (pathname === '/api/diagrams') {
        if (method === 'GET') {
          const includeArchived = url.searchParams.get('archived') === 'true';
          return send(response, 200, [...documents.values()].filter(item => includeArchived || !item.archived)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map(summary));
        }
        if (method === 'POST') {
          if (documents.size >= 100) throw failure(400, 'This disposable preview supports up to 100 boards');
          const value = snapshotRequest(await body(request)), now = new Date().toISOString();
          return send(response, 201, save({ id: randomUUID(), ...value, revision: 1, schemaVersion: 1, createdAt: now, updatedAt: now, archived: false }));
        }
        throw failure(405, 'Unsupported preview diagram operation');
      }
      const match = pathname.match(new RegExp(`^/api/diagrams/(${UUID_PATTERN})(/restore|/permanent)?$`));
      if (match) {
        const id = match[1].toLowerCase(), document = documents.get(id);
        if (!document) throw failure(404, 'Preview diagram not found');
        if (method === 'GET' && !match[2]) return send(response, 200, document);
        if (method === 'PUT' && !match[2]) {
          const value = await body(request);
          revisionMatches(document, value.revision);
          if (document.archived) throw failure(409, 'Restore this preview diagram before editing');
          return send(response, 200, save({ ...document, ...snapshotRequest(value), revision: document.revision + 1, updatedAt: new Date().toISOString() }));
        }
        if (method === 'DELETE' && !match[2]) {
          const supplied = url.searchParams.get('revision');
          revisionMatches(document, supplied === null ? null : Number(supplied));
          return send(response, 200, summary(document.archived ? document : save({ ...document, archived: true, revision: document.revision + 1, updatedAt: new Date().toISOString() })));
        }
        if (method === 'DELETE' && match[2] === '/permanent') {
          const supplied = url.searchParams.get('revision');
          revisionMatches(document, supplied === null ? null : Number(supplied));
          documents.delete(id);
          response.writeHead(204); return response.end();
        }
        if (method === 'POST' && match[2] === '/restore') {
          revisionMatches(document, (await body(request)).revision);
          return send(response, 200, document.archived ? save({ ...document, archived: false, revision: document.revision + 1, updatedAt: new Date().toISOString() }) : document);
        }
        throw failure(405, 'Unsupported preview diagram operation');
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/mcp/') || pathname.startsWith('/internal/')) throw failure(404, 'No real backend exists in this isolated preview');
      if (!['GET', 'HEAD'].includes(method)) throw failure(405, 'Preview assets are read-only');
      const relative = ['/', '/diagram-studio', '/diagram-studio/'].includes(pathname) ? 'index.html' : pathname.replace(/^\/+/, '');
      const root = await fs.realpath(assetRoot), file = await fs.realpath(path.resolve(root, relative));
      if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile()) throw failure(404, 'Preview asset not found');
      const content = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Content-Length': content.length });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, error.status || 404, { error: error.status ? error.message : 'Preview asset not found; build the frontend first' });
      else response.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  if (process.argv.length > 2) throw new Error('Use ARGUS_DIAGRAM_PREVIEW_PORT to select a port; no arguments are accepted.');
  const port = Number(process.env.ARGUS_DIAGRAM_PREVIEW_PORT ?? 4179);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ARGUS_DIAGRAM_PREVIEW_PORT must be from 0 to 65535.');
  await fs.access(path.join(exportedRoot, 'index.html')).catch(() => { throw new Error('Build frontend/out first with npm run build:frontend. This fixture does not build or launch Argus.'); });
  const server = createDiagramStudioPreviewServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`ISOLATED DIAGRAM QA — all boards exist only in memory:\nhttp://127.0.0.1:${server.address().port}/diagram-studio\nRestarting this server clears all preview boards. No Argus backend or profile is used.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
