import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanConnectionRouting,connectionGeometry,insertConnectionBend,moveInternalConnectionRoutes} from '../frontend/features/diagrams/diagram-connection-routing.mjs';
import {cleanStructured,exportBoard,parseBoardImport,emptySnapshot,duplicateSelection} from '../frontend/features/diagrams/diagram-model.mjs';
import {exportStructuredSvg} from '../frontend/features/diagrams/diagram-svg.mjs';
const start={x:20,y:40,direction:'right'},end={x:500,y:240,direction:'left'};
test('legacy connections remain unchanged; route import rejects unbounded or executable data',()=>{
  assert.equal(connectionGeometry({curvature:.3},start,end),null);
  assert.deepEqual(cleanConnectionRouting(null),{});
  assert.deepEqual(cleanConnectionRouting({routing:'javascript:x',waypoints:[{x:1,y:2,evil:'x'},{x:NaN,y:3},{x:2e6,y:0}],labelOffset:{x:Infinity,y:0}}),{waypoints:[{x:1,y:2}]});
  assert.equal(cleanConnectionRouting({waypoints:Array(1000).fill({x:1,y:2})}).waypoints.length,64);
});
test('all sixteen endpoint directions produce finite rounded orthogonal elbow paths',()=>{
  for(const source of ['left','right','top','bottom'])for(const target of ['left','right','top','bottom']){
    const route=connectionGeometry({routing:'elbow'},{...start,direction:source},{...end,direction:target});
    assert.deepEqual(route.points[0],{...start,direction:source});assert.deepEqual(route.points.at(-1),{...end,direction:target});
    route.points.slice(1).forEach((p,i)=>assert.ok(p.x===route.points[i].x||p.y===route.points[i].y));
    assert.ok(!/NaN|Infinity/.test(route.path));assert.match(route.path,/Q/);
  }
});
test('arbitrary bends, arc/straight styles, labels, self loops and insertion remain editable',()=>{
  const hump=connectionGeometry({routing:'elbow',waypoints:[{x:200,y:-80}]},start,{...end,y:40});
  assert.ok(hump.points.some((p,i)=>i&&p.y===-80&&hump.points[i-1].y===-80&&p.x!==hump.points[i-1].x),'a moved bend must create a real detour, not an out-and-back spike');
  for(const routing of ['elbow','straight','curve']){
    const data={routing,waypoints:[{x:120,y:-100},{x:390,y:430}],labelOffset:{x:22,y:-35}};
    const route=connectionGeometry(data,start,end),base=connectionGeometry({...data,labelOffset:undefined},start,end);
    assert.equal(route.labelX-base.labelX,22);assert.equal(route.labelY-base.labelY,-35);
    assert.match(route.path,routing==='curve'?/C/:/L/);
    const bends=insertConnectionBend(route,{x:230,y:60});assert.equal(bends.length,3);assert.ok(bends.some(p=>p.x===230&&p.y===60));
  }
  assert.ok(connectionGeometry({routing:'elbow'},start,start).points.length>2);
  for(const routing of ['straight','curve'])assert.ok(connectionGeometry({routing},start,start).waypoints.length>1,'self arrows must remain visible and editable');
  const aligned=connectionGeometry({routing:'elbow',waypoints:[{x:250,y:-90},{x:250,y:240}]},start,end);
  aligned.points.slice(1,-1).forEach((b,i)=>{const a=aligned.points[i],c=aligned.points[i+2];assert.ok((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)>=0,'orthogonal bends must not retrace as a zero-width spike');});
  const curve=connectionGeometry({routing:'curve',waypoints:[{x:-5000,y:0},{x:5000,y:1}]},start,end);assert.ok(curve.controls.some(p=>p.x < -5000 || p.x > 5000),'curve export bounds must include Bezier controls, not just anchors');
});
const graph=()=>({nodes:[{id:'a',type:'component',position:{x:0,y:0},data:{name:'API',componentKey:'service'},selected:true},{id:'b',type:'component',position:{x:450,y:160},data:{name:'DB',componentKey:'database'},selected:true}],edges:[{id:'ab',type:'relation',source:'a',target:'b',sourceHandle:'right',targetHandle:'left',data:{relation:'association',curvature:.3,label:'request',routing:'elbow',waypoints:[{x:300,y:-120},{x:400,y:100}],labelOffset:{x:0,y:-45}}}],viewport:{x:0,y:0,zoom:1}});
test('authored routes survive board save/import and portable SVG exports',()=>{
  const initial=graph(),snapshot={...emptySnapshot(),structured:initial};
  const parsed=parseBoardImport(exportBoard({name:'Routes',snapshot}));
  assert.deepEqual(parsed.snapshot.structured.edges[0].data,cleanStructured(initial).edges[0].data);
  const svg=exportStructuredSvg(initial);assert.match(svg,/Q/);assert.ok(svg.includes('300'));assert.ok(!svg.includes('NaN'));
});
test('duplicate / paste and group translation move internal route bends exactly once',()=>{
  const original=graph(),copy=duplicateSelection(original.nodes,original.edges,32);
  assert.deepEqual(copy.edges[0].data.waypoints,[{x:332,y:-88},{x:432,y:132}]);
  const moved={...original,nodes:original.nodes.map(n=>({...n,position:{x:n.position.x+40,y:n.position.y+70}}))};
  assert.deepEqual(moveInternalConnectionRoutes(original,moved).edges[0].data.waypoints,[{x:340,y:-50},{x:440,y:170}]);
  const one={...original,nodes:[moved.nodes[0],original.nodes[1]]};assert.deepEqual(moveInternalConnectionRoutes(original,one).edges,original.edges);
  assert.deepEqual(original.edges[0].data.waypoints,[{x:300,y:-120},{x:400,y:100}]);
});
