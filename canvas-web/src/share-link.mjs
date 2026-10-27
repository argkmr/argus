// Capabilities only travel in the fragment and authenticated request bodies.
// A URL fragment is excluded from HTTP requests and Referer headers.
export function parseCanvasShareLink(hash = '') {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  const server = parameters.get('server');
  const boardId = parameters.get('board');
  const token = parameters.get('invite') || parameters.get('token');
  if (!server || !boardId || !token) throw new Error('Open the complete sharing link supplied by the board owner.');
  const endpoint = new URL(server);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) throw new Error('The sharing server must use HTTPS.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('This sharing server address is invalid.');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(boardId) || token.length > 8192 || /[\s\u0000-\u001f]/.test(token)) throw new Error('This sharing link is invalid.');
  return { endpoint: endpoint.href.replace(/\/$/, ''), boardId, token };
}

export function canvasStatusLabel(status) {
  const labels = { connecting: 'Connecting…', syncing: 'Syncing…', saved: 'All changes saved', offline: 'Offline · draft kept in this browser', pending: 'Saving changes…', 'read-only': 'Read-only', expired: 'Access expired', error: 'Connection problem' };
  return labels[status?.state] || 'Connecting…';
}
