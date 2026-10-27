import path from 'node:path';
import { createCanvasService } from '../canvas-server/service.mjs';

// This bridge is invoked only by trusted Electron IPC. It is never an HTTP
// route on the shared listener. The upstream is fixed by the application.
export function createDesktopCanvasSharing({ dataDir, baseUrl, port = 4187, fetchImpl = fetch, serviceFactory = createCanvasService }) {
  const upstream = new URL(baseUrl);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('Canvas storage must use the local Argus backend.');
  }
  let service, starting;
  const boardId = id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid board ID.');
    return id;
  };
  async function request(id, options = {}) {
    const response = await fetchImpl(new URL('/api/diagrams/' + boardId(id), upstream), {
      ...options, headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || value.message || `Local board storage failed (${response.status}).`);
      error.status = response.status; throw error;
    }
    return value;
  }
  async function getService() {
    if (!starting) starting = (async () => {
      service = await serviceFactory({
        dataDir: path.join(dataDir, 'canvas-sharing'), port, host: '127.0.0.1', origins: [upstream.origin],
        loadBoard: id => request(id),
        saveBoard: (board, expectedRevision) => request(board.id, {
          method: 'PUT', body: JSON.stringify({ name: board.name, snapshot: board.snapshot, revision: expectedRevision }),
        }),
      });
      await service.start();
      return service;
    })().catch(async error => {
      const failed = service;
      starting = null; service = null;
      await failed?.close().catch(() => {});
      throw error;
    });
    return starting;
  }
  return {
    async invoke(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Canvas sharing request.');
      const allowed = new Set(['status', 'configure', 'share', 'session', 'invites', 'invite', 'revoke', 'stop', 'forget']);
      if (!allowed.has(input.action)) throw new Error('Unsupported Canvas sharing action.');
      const current = await getService();
      switch (input.action) {
        case 'status': return current.status();
        case 'configure': return current.configure({ publicUrl: input.publicUrl, frontendUrl: input.frontendUrl, allowedOrigins: input.allowedOrigins });
        case 'share': return current.share(await request(input.boardId));
        case 'session': return current.ownerSession(boardId(input.boardId));
        case 'invites': return current.listInvites(boardId(input.boardId));
        case 'invite': return current.createInvite(boardId(input.boardId), { role: input.role, expiresInHours: input.expiresInHours });
        case 'revoke': return current.revokeInvite(boardId(input.boardId), input.inviteId);
        case 'stop': return current.stopSharing(boardId(input.boardId));
        case 'forget': return current.forget(boardId(input.boardId));
      }
    },
    resume: getService,
    async close() {
      // Failure to start the optional sharing listener must never prevent
      // shutdown of Argus's private backend.
      if (starting) await starting.catch(() => {});
      if (service) await service.close();
      service = null; starting = null;
    },
  };
}
