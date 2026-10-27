// Synthetic public documentation, shaped after the published Markdown contract.
// GPT-7 Future is intentionally fictional. No account or user data is used.
const http = require('node:http');

const pricing = `# Synthetic Codex pricing

<table>
<tr><th>Credits per 1M tokens</th><th>Input Tokens</th><th>Cached input tokens</th><th>Output Tokens</th></tr>
<tr><td>GPT-7 Future</td><td>123 credits</td><td>12.3 credits</td><td>456 credits</td></tr>
<tr><td>GPT-6 Sol</td><td>50 credits</td><td>5 credits</td><td>250 credits</td></tr>
</table>

Fast mode uses 2x the Standard rate where available, and Ultrafast mode uses 6x the Standard rate where available.
Codex credit billing has no separate cache-write charge.
`;

const speed = `# Synthetic Codex speed policy

Fast mode speeds up supported models, including GPT-6 Sol, where available.
Fast mode uses included subscription limits at 2.5x.
Ultrafast supports GPT-6 Astra and GPT-6.1 Sol.
Ultrafast uses included subscription limits at 8x.
`;

const documents = new Map([
  ['/docs/pricing.md', pricing],
  ['/docs/agent-configuration/speed.md', speed],
]);

http.createServer((request, response) => {
  const body = request.method === 'GET' && documents.get(new URL(request.url, 'http://127.0.0.1').pathname);
  response.writeHead(body ? 200 : 501, {
    'Content-Type': body ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body || JSON.stringify({ error: 'This synthetic fixture does not model that request.' }));
}).listen(process.env.PORT);
