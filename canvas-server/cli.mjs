#!/usr/bin/env node
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createCanvasService } from './service.mjs';

const args = process.argv.slice(2), options = {};
const usage = `Usage: node canvas-server/cli.mjs [--share BOARD_ID] [--invite view|edit] [--expires-hours HOURS]
Required environment: CANVAS_DATA_DIR (absolute, dedicated directory)
Optional: CANVAS_BACKEND_URL (default http://127.0.0.1:4173), CANVAS_PORT (4186),
          CANVAS_PUBLIC_URL (HTTPS tunnel origin), CANVAS_FRONTEND_URL (HTTPS frontend origin).
After startup, enter one JSON command per line on trusted local stdin:
  {"action":"share","boardId":"BOARD_ID"}
  {"action":"invite","boardId":"BOARD_ID","role":"view","expiresInHours":24}
  {"action":"invites","boardId":"BOARD_ID"}
  {"action":"revoke","boardId":"BOARD_ID","inviteId":"INVITE_ID"}
  {"action":"stop","boardId":"BOARD_ID"}
  {"action":"status"}
  {"action":"configure","publicUrl":"https://example.ngrok-free.app","frontendUrl":"https://example.netlify.app"}
Invitation secrets are printed only in the requested invitation response. No public admin endpoint exists.
`;
if (args.includes('--help')) { process.stdout.write(usage); process.exit(0); }
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!['--share', '--invite', '--expires-hours'].includes(key) || !value || value.startsWith('--')) throw new Error(usage);
  options[key.slice(2)] = value;
}
if (options.invite && !options.share) throw new Error('--invite requires --share BOARD_ID. Use the local stdin invite command for an already shared board.');

// The upstream is chosen once by the owner. No public request can select a URL,
// HTTP method, backend route, file path, or other Argus capability.
const backend = new URL(process.env.CANVAS_BACKEND_URL || 'http://127.0.0.1:4173');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname) || backend.protocol !== 'http:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('CANVAS_BACKEND_URL must be a loopback HTTP origin.');
}
if (!process.env.CANVAS_DATA_DIR || !path.isAbsolute(process.env.CANVAS_DATA_DIR)) throw new Error('Set CANVAS_DATA_DIR to an absolute directory dedicated to Canvas sharing.');
const requestBoard = async (id, options) => {
  const response = await fetch(new URL(`/api/diagrams/${encodeURIComponent(id)}`, backend), { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error('The local board request failed.'), { status: response.status, code: response.status === 409 ? 'conflict' : 'unavailable' });
  return response.json();
};
const service = createCanvasService({
  dataDir: process.env.CANVAS_DATA_DIR,
  port: Number(process.env.CANVAS_PORT || 4186),
  loadBoard: id => requestBoard(id),
  saveBoard: (board, expectedRevision) => requestBoard(board.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: board.name, snapshot: board.snapshot, revision: expectedRevision }) }),
});
await service.start();
if (process.env.CANVAS_PUBLIC_URL || process.env.CANVAS_FRONTEND_URL) await service.configure({ publicUrl: process.env.CANVAS_PUBLIC_URL || '', frontendUrl: process.env.CANVAS_FRONTEND_URL || '' });
console.info(`Canvas board-only service listening on 127.0.0.1:${service.status().port}. Enter local JSON commands or press Ctrl+C to stop.`);
const respond = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (options.share) {
  await service.share(await requestBoard(options.share));
  if (options.invite) respond(await service.createInvite(options.share, { role: options.invite, expiresInHours: Number(options['expires-hours'] || 24) }));
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let commands = Promise.resolve();
input.on('line', line => {
  // Local terminal commands have their own small bound and are never forwarded
  // by the public listener. Serializing them keeps management results ordered.
  commands = commands.then(async () => {
    if (!line.trim()) return;
    if (line.length > 4096) throw new Error('Local command is too large.');
    const command = JSON.parse(line);
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('A JSON command is required.');
    let result;
    switch (command.action) {
      case 'share': result = await service.share(await requestBoard(command.boardId)); break;
      case 'invite': result = await service.createInvite(command.boardId, { role: command.role, expiresInHours: command.expiresInHours }); break;
      case 'invites': result = await service.listInvites(command.boardId); break;
      case 'revoke': result = await service.revokeInvite(command.boardId, command.inviteId); break;
      case 'stop': result = await service.stopSharing(command.boardId); break;
      case 'status': result = service.status(); break;
      case 'configure': result = await service.configure({ publicUrl: command.publicUrl, frontendUrl: command.frontendUrl, allowedOrigins: command.allowedOrigins }); break;
      default: throw new Error('Unsupported local command. Run with --help for available commands.');
    }
    respond({ ok: true, action: command.action, result });
  }).catch(cause => respond({ ok: false, error: cause.code || 'invalid_command', message: cause.message }));
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; input.close(); await commands; await service.close(); process.exit(0); });
