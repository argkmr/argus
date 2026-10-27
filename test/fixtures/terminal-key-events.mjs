// Opt-in browser-input diagnostic; no shell, commands, or user data are used.
import http from "node:http";
import fs from "node:fs/promises";
const assets = new URL("../../public/vendor/xterm/", import.meta.url);
const html = `<!doctype html><html><head><link rel="stylesheet" href="/xterm.css"></head>
<body><h1>Disposable terminal keyboard diagnostic</h1><div id="terminal" style="height:220px"></div><pre id="events"></pre>
<script type="module">
import { Terminal } from '/xterm.mjs';
const events=document.querySelector('#events');
const record=value=>events.textContent+=JSON.stringify(value)+'\\n';
document.addEventListener('keydown',event=>record({type:event.type,key:event.key,code:event.code,keyCode:event.keyCode,ctrl:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey,target:event.target.tagName}),true);
const term=new Terminal({screenReaderMode:true});term.open(document.querySelector('#terminal'));
term.attachCustomKeyEventHandler(event=>{event.stopPropagation();return true;});
term.onData(data=>record({data,hex:Array.from(data,c=>c.codePointAt(0).toString(16))}));
term.write('Type abc, then Ctrl+C. No shell is attached.\\r\\n');term.focus();
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(html); return; }
  const files = { "/xterm.css": "text/css", "/xterm.mjs": "application/javascript" };
  if (!files[req.url]) { res.statusCode = 404; res.end(); return; }
  res.setHeader("Content-Type", files[req.url]);
  res.end(await fs.readFile(new URL(req.url.slice(1), assets)));
});
server.listen(4198, "127.0.0.1", () => console.log("Disposable keyboard diagnostic: http://127.0.0.1:4198"));
const stop=()=>server.close(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop);
