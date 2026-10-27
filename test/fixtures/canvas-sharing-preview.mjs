// Synthetic-only collaboration preview. No Argus profile/backend/tunnel access.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasService } from '../../canvas-server/service.mjs';
import { templateSnapshot } from '../../frontend/features/diagrams/diagram-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'};

export async function createCanvasPreview(temporary, {staticRoot = path.join(root, 'canvas-web/dist'), snapshot = templateSnapshot('class')} = {}) {
  if (!path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-canvas-ui-')) throw new Error('An isolated canvas UI test directory is required.');
  const policy = (await fs.readFile(path.join(root,'canvas-web/public/_headers'),'utf8')).split('\n').find(line=>line.trim().startsWith('Content-Security-Policy:')).trim().slice('Content-Security-Policy:'.length).trim();
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    requests.push({url:req.url,referrer:req.headers.referer||''});
    try {
      const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const target = path.resolve(staticRoot,'.'+(pathname==='/'?'/index.html':pathname));
      if(!target.startsWith(staticRoot+path.sep)) {res.writeHead(404).end();return;}
      const body=await fs.readFile(target);
      res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Content-Security-Policy':policy,'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(body);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const frontend=`http://127.0.0.1:${server.address().port}`;
  const state={board:{id:'synthetic-ui-board',name:'Checkout architecture',revision:1,archived:false,schemaVersion:1,snapshot},saves:0};
  const service=createCanvasService({dataDir:path.join(temporary,'service'),port:0,
    loadBoard:async id=>id===state.board.id?structuredClone(state.board):null,
    saveBoard:async(candidate,revision)=>{if(revision!==state.board.revision)throw new Error('Synthetic revision conflict');state.board={...structuredClone(candidate),revision:revision+1};state.saves++;return structuredClone(state.board);},
  });
  await service.start();await service.configure({frontendUrl:frontend,allowedOrigins:[frontend]});await service.share(state.board);
  const editor=await service.createInvite(state.board.id,{role:'edit'}),viewer=await service.createInvite(state.board.id,{role:'view'});
  const endpoint=`http://127.0.0.1:${service.status().port}`;
  const link=invite=>frontend+'/#'+new URLSearchParams({server:endpoint,board:state.board.id,invite:invite.token});
  return {state,requests,frontend,endpoint,editor,viewer,editorUrl:link(editor),viewerUrl:link(viewer),service,async close(){await service.close();await new Promise(resolve=>server.close(resolve));}};
}
