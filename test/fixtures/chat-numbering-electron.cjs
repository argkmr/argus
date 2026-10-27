// The production Markdown renderer and styles, with synthetic text only.
// No backend, provider, installed app, user data or repository is accessed.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-chat-numbering-')) throw new Error('An isolated fixture directory is required.');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0, completed = false;
const timer = setTimeout(() => finish(new Error('Chat numbering fixture timed out')), 34_000);
function finish(error, result) {
  if (completed) return; completed = true; clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log('CHAT_NUMBERING_RESULT=' + JSON.stringify(result));
  window?.destroy(); app.exit(error ? 1 : 0);
}

const cases = [
  { id: 'normal', title: 'Normal list', text: '1. Plan the change\n2. Implement the change\n3. Verify the change', lists: [[1, 2, 3]] },
  { id: 'loose', title: 'Blank lines between steps', text: '1. Check the request\n\n2. Run the test\n\n3. Ship the fix', lists: [[1, 2, 3]] },
  { id: 'repeated', title: 'Markdown with repeated “1.”', text: '1. Read the source\n\n1. Make the change\n\n1. Review the result', lists: [[1, 2, 3]] },
  { id: 'start', title: 'Continue from step five', text: '5. Test the migration\n\n6. Verify the rollout\n\n7. Monitor the release', lists: [[5, 6, 7]] },
  { id: 'nested', title: 'Nested steps and continuation', text: '1. Prepare the application\n   Keep this explanation with step one.\n\n   1. Warm the cache\n   2. Check the index\n2. Start the worker', lists: [[1, 2], [1, 2]], nested: true },
  { id: 'separate', title: 'Separate lists keep their own starts', text: '1. First group\n2. Second item\n\nAn independent next phase.\n\n5. New phase\n6. Final check', lists: [[1, 2], [5, 6]] },
];
const stream = ['1. Read', '1. Read the source\n\n2. Implement', '1. Read the source\n\n2. Implement the fix\n\n3.', '1. Read the source\n\n2. Implement the fix\n\n3. Verify the result'];
const streamExpected = [[[1]], [[1, 2]], [[1, 2]], [[1, 2, 3]]];
const surfaces = ['repository', 'nexus', 'ide'];

app.whenReady().then(async () => {
  const { renderChatMessage } = await import(pathToFileURL(path.join(root, 'public/message-renderer.js')).href);
  const styles = await fs.readFile(path.join(root, 'public/styles.css'), 'utf8');
  const ideStyles = await fs.readFile(path.join(root, 'public/ide-code-chat.css'), 'utf8');
  const message = (surface, id, body) => surface === 'ide'
    ? `<article class="ide-code-chat-message ide-code-chat-message-assistant"><div class="chat-message-content" data-case="${id}">${body}</div></article>`
    : `<article class="chat-message assistant"><div class="chat-message-body"><div class="chat-message-content" data-case="${id}">${body}</div></div></article>`;
  const panels = surfaces.map(surface => {
    const attributes = surface === 'nexus' ? 'id="global-codex-panel"' : surface === 'ide' ? 'class="ide-code-chat"' : '';
    const content = [...cases.map(item => `<section class="fixture-case"><h3>${item.title}</h3>${message(surface, item.id, renderChatMessage(item.text))}</section>`), `<section class="fixture-case"><h3>Streaming response</h3>${message(surface, 'stream', '')}</section>`].join('');
    return `<section class="fixture-panel" data-surface="${surface}"><h2>${surface === 'ide' ? 'Inline IDE chat' : surface === 'nexus' ? 'Nexus' : 'Repository chat'}</h2><div ${attributes} data-fixture-host>${content}</div></section>`;
  }).join('');
  const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Isolated chat numbering</title><style>${styles}\n${ideStyles}\n
  body{padding:18px;overflow:auto;font-family:system-ui,sans-serif;zoom:1!important}#fixture{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}h1.fixture-title{font-size:17px;margin:0 0 8px}.fixture-caption{font-size:11px;color:var(--muted);margin:0 0 16px}.fixture-panel{min-width:0}.fixture-panel>h2{font-size:15px;margin:0 0 12px}.fixture-case{padding:0 0 10px;min-width:0}.fixture-case>h3{font-size:11px;margin:0 0 6px;color:var(--muted)}[data-fixture-host],#global-codex-panel[data-fixture-host],.ide-code-chat[data-fixture-host]{position:static!important;inset:auto!important;width:auto!important;height:auto!important;min-height:0;max-height:none;display:block!important;overflow:visible;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);box-shadow:none}.fixture-panel .chat-message-body{max-width:100%}
  </style></head><body><h1 class="fixture-title">Ordered replies · native numbering regression</h1><p class="fixture-caption">Synthetic content only · shared production renderer and chat styles · no provider or backend</p><main id="fixture">${panels}</main></body></html>`;
  const isolated = session.fromPartition('isolated-chat-numbering', { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1320, height: 1280, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const evaluate = source => window.webContents.executeJavaScript(`(async()=>{${source}})()`);
  const sandboxed = await evaluate('return typeof require === "undefined" && typeof process === "undefined";');
  const settle = 'await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));';
  let scenarios = 0;
  const colors = {};
  const inspect = async (surface, id) => evaluate(`
    const content=document.querySelector('[data-surface="${surface}"] [data-case="${id}"]');
    const bounds=content.getBoundingClientRect();
    const lists=[...content.querySelectorAll('ol')].map(list=>{
      let next=list.start;
      const items=[...list.children].filter(item=>item.tagName==='LI');
      const numbers=items.map(item=>{if(item.hasAttribute('value'))next=item.value;return next++;});
      return {numbers,type:getComputedStyle(list).listStyleType,indent:parseFloat(getComputedStyle(list).paddingLeft),nested:list.parentElement.tagName==='LI',items:items.map(item=>{const box=item.getBoundingClientRect();return {display:getComputedStyle(item).display,left:box.left,right:box.right,top:box.top,bottom:box.bottom};})};
    });
    return {lists,text:content.textContent,overflow:content.scrollWidth>content.clientWidth+1,bounds:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom},color:getComputedStyle(content).color};
  `);
  const check = (result, expected, label) => {
    assert.deepEqual(result.lists.map(list => list.numbers), expected, label);
    assert.equal(result.overflow, false, `${label}: no horizontal clipping`);
    for (const list of result.lists) {
      assert.equal(list.type, 'decimal', `${label}: native decimal markers remain enabled`);
      assert.ok(list.indent >= 18, `${label}: markers have room`);
      list.items.forEach((item, index) => {
        assert.equal(item.display, 'list-item', `${label}: native list-item semantics`);
        assert.ok(item.left >= result.bounds.left && item.right <= result.bounds.right + 1, `${label}: item stays in its message`);
        if (index) assert.ok(item.top >= list.items[index - 1].bottom, `${label}: sibling items do not overlap`);
      });
    }
  };
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};${settle}`);
    for (const surface of surfaces) {
      for (const item of cases) {
        const result = await inspect(surface, item.id); check(result, item.lists, `${theme}/${surface}/${item.id}`);
        if (item.nested) { assert.equal(result.lists[1].nested, true); assert.match(result.text, /Keep this explanation with step one/); }
        scenarios++;
      }
      for (const [index, text] of stream.entries()) {
        await evaluate(`document.querySelector('[data-surface="${surface}"] [data-case="stream"]').innerHTML=${JSON.stringify(renderChatMessage(text))};${settle}`);
        const result = await inspect(surface, 'stream'); check(result, streamExpected[index], `${theme}/${surface}/stream-${index}`); scenarios++;
      }
      colors[`${theme}/${surface}`] = (await inspect(surface, 'normal')).color;
    }
    // macOS clamps hidden windows to the display height. Capture both ends at
    // native scale so the final streaming case is visible as well as the first.
    await evaluate(`document.body.scrollTop=0;${settle}`);
    await fs.writeFile(path.join(temporary, `chat-numbering-${theme}-top.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.body.scrollTop=document.body.scrollHeight;${settle}`);
    assert.equal(await evaluate('return [...document.querySelectorAll("[data-case=stream]")].every(item=>item.getBoundingClientRect().bottom<=innerHeight+1);'), true, `${theme}: streaming cases fit the lower proof`);
    await fs.writeFile(path.join(temporary, `chat-numbering-${theme}-bottom.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.body.scrollTop=0;${settle}`);
  }
  for (const surface of surfaces) assert.notEqual(colors[`dark/${surface}`], colors[`light/${surface}`], `${surface}: real theme styling applied`);
  assert.equal(networkRequests, 0);
  finish(null, { ok: true, sandboxed, scenarios, screenshots: 4, networkRequests });
}).catch(error => finish(error));
