// Portable, bounded routing data shared by the live canvas, exports and peers.
export const MAX_BENDS = 64;
const valid = n => Number.isFinite(n) && Math.abs(n) <= 1_000_000;
const point = p => p && valid(p.x) && valid(p.y);
const same = (a,b) => Math.abs(a.x-b.x)<.001 && Math.abs(a.y-b.y)<.001;
const direction = {left:[-1,0],right:[1,0],top:[0,-1],bottom:[0,1]};
export function cleanConnectionRouting(data={}) {
  if(!data || typeof data!=='object')data={};
  const result={};
  if(['elbow','straight','curve'].includes(data.routing))result.routing=data.routing;
  if(Array.isArray(data.waypoints))result.waypoints=data.waypoints.filter(point).slice(0,MAX_BENDS).map(p=>({x:p.x,y:p.y}));
  if(point(data.labelOffset))result.labelOffset={x:data.labelOffset.x,y:data.labelOffset.y};
  return result;
}
function compact(points) {
  const out=[];
  for(const p of points){
    if(out.length&&same(out.at(-1),p))continue;
    while(out.length>1){const a=out.at(-2),b=out.at(-1);if((a.x===b.x&&b.x===p.x||a.y===b.y&&b.y===p.y)&&(b.x-a.x)*(p.x-b.x)+(b.y-a.y)*(p.y-b.y)>=0)out.pop();else break;}
    out.push({...p});
  }
  return out;
}
function detourReversals(points) {
  const out=[];
  for(let i=0;i<points.length;i++){
    const b=points[i];out.push(b);
    if(i===0||i===points.length-1)continue;
    const a=points[i-1],c=points[i+1],vertical=a.x===b.x&&b.x===c.x,horizontal=a.y===b.y&&b.y===c.y;
    if((vertical||horizontal)&&((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)<0)){
      const d=points[i+2],shift=vertical?(d&&d.x!==c.x?-Math.sign(d.x-c.x)*32:32):(d&&d.y!==c.y?-Math.sign(d.y-c.y)*32:32);
      out.push(vertical?{x:b.x+shift,y:b.y}:{x:b.x,y:b.y+shift},vertical?{x:c.x+shift,y:c.y}:{x:c.x,y:c.y+shift});
    }
  }
  return compact(out);
}
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function roundedPolyline(points,radius=10) {
  if(!points.length)return '';
  let path=`M ${points[0].x} ${points[0].y}`;
  for(let i=1;i<points.length-1;i++){
    const a=points[i-1],b=points[i],c=points[i+1],r=Math.min(radius,distance(a,b)/2,distance(b,c)/2);
    if(r<.001){path+=` L ${b.x} ${b.y}`;continue;}
    const before={x:b.x+(a.x-b.x)*r/distance(a,b),y:b.y+(a.y-b.y)*r/distance(a,b)},after={x:b.x+(c.x-b.x)*r/distance(b,c),y:b.y+(c.y-b.y)*r/distance(b,c)};
    path+=` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  if(points.length>1)path+=` L ${points.at(-1).x} ${points.at(-1).y}`;
  return path;
}
function arc(points) {
  let path=`M ${points[0].x} ${points[0].y}`;
  for(let i=0;i<points.length-1;i++){
    const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
    path+=` C ${b.x+(c.x-a.x)/6} ${b.y+(c.y-a.y)/6} ${c.x-(d.x-b.x)/6} ${c.y-(d.y-b.y)/6} ${c.x} ${c.y}`;
  }
  return path;
}
function midpoint(points) {
  let left=points.slice(1).reduce((sum,p,i)=>sum+distance(points[i],p),0)/2;
  for(let i=1;i<points.length;i++){const len=distance(points[i-1],points[i]);if(left<=len&&len){const t=left/len;return{x:points[i-1].x+(points[i].x-points[i-1].x)*t,y:points[i-1].y+(points[i].y-points[i-1].y)*t};}left-=len;}
  return points[0];
}
function sampleCubic(a,b,c,d) {
  return Array.from({length:12},(_,i)=>{const t=(i+1)/12,u=1-t;return{x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y};});
}
export function connectionGeometry(data,start,end) {
  const clean=cleanConnectionRouting(data);
  if(!clean.routing&&!clean.waypoints?.length)return null; // Preserve legacy paths.
  const routing=clean.routing||'curve',manual=clean.waypoints||[],sd=direction[start.direction]||direction.right,td=direction[end.direction]||direction.left;
  let points;
  if(routing==='elbow'){
    const a={x:start.x+sd[0]*28,y:start.y+sd[1]*28},b={x:end.x+td[0]*28,y:end.y+td[1]*28};
    points=[start,a];
    if(manual.length){
      let previous=a;
      for(const [index,p] of [...manual,b].entries()){
        const horizontal=index===manual.length?Boolean(td[0]):Boolean(sd[0]);
        points.push(horizontal?{x:p.x,y:previous.y}:{x:previous.x,y:p.y},p);previous=p;
      }
    }else if(sd[0]&&td[0]){
      const x=sd[0]===td[0]?(sd[0]>0?Math.max(a.x,b.x)+40:Math.min(a.x,b.x)-40):(a.x+b.x)/2;
      points.push({x,y:a.y},{x,y:b.y},b);
    }else if(sd[1]&&td[1]){
      const y=sd[1]===td[1]?(sd[1]>0?Math.max(a.y,b.y)+40:Math.min(a.y,b.y)-40):(a.y+b.y)/2;
      points.push({x:a.x,y},{x:b.x,y},b);
    }else points.push(sd[0]?{x:b.x,y:a.y}:{x:a.x,y:b.y},b);
    points.push(end);points=detourReversals(compact(points));
    // Coincident/self endpoints still need an editable loop, never a zero path.
    if(points.length<3&&same(start,end))points=[start,a,{x:a.x+60,y:a.y},{x:a.x+60,y:a.y+70},{x:end.x,y:a.y+70},end];
  }else points=compact([start,...manual,end]);
  const self=!manual.length&&same(start,end);
  if(self&&routing!=='elbow')points=[start,{x:start.x+sd[0]*80,y:start.y+sd[1]*80},{x:start.x+sd[0]*80+(sd[0]?0:80),y:start.y+sd[1]*80+(sd[0]?80:0)},end];
  if(points.length===1)points.push({x:end.x+1,y:end.y});
  const editPoints=points;
  let path=routing==='curve'?arc(points):roundedPolyline(points,routing==='elbow'?10:0);
  let controls=points;
  if(routing==='curve'&&!manual.length&&!self){
    const length=Math.max(45,distance(start,end)*Math.max(.05,Math.min(1.2,data.curvature||.3))),a={x:start.x+sd[0]*length,y:start.y+sd[1]*length},b={x:end.x+td[0]*length,y:end.y+td[1]*length};
    path=`M ${start.x} ${start.y} C ${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`;
    controls=[start,a,b,end];points=[start,...sampleCubic(start,a,b,end)];
  }else if(routing==='curve'){
    controls=[...points];const samples=[points[0]];
    for(let i=0;i<points.length-1;i++){const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)],first={x:b.x+(c.x-a.x)/6,y:b.y+(c.y-a.y)/6},second={x:c.x-(d.x-b.x)/6,y:c.y-(d.y-b.y)/6};controls.push(first,second);samples.push(...sampleCubic(b,first,second,c));}
    points=samples;
  }
  const middle=midpoint(points);
  const offset=clean.labelOffset||{x:0,y:0};
  const automatic=(routing==='elbow'&&editPoints.length>2)||self?editPoints.slice(1,-1):[routing==='curve'?points[Math.floor(points.length*.25)]:{x:start.x*.75+end.x*.25,y:start.y*.75+end.y*.25}];
  return {routing,points,controls,waypoints:manual.length?manual:automatic,path,labelX:middle.x+offset.x,labelY:middle.y+offset.y};
}
export function insertConnectionBend(geometry,position) {
  const base=geometry.waypoints.map(p=>({...p}));
  if(base.length>=MAX_BENDS)return base;
  const anchors=[geometry.points[0],...base,geometry.points.at(-1)];
  let best=Infinity,index=0;
  for(let i=0;i<anchors.length-1;i++){
    const a=anchors[i],b=anchors[i+1],dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((position.x-a.x)*dx+(position.y-a.y)*dy)/(dx*dx+dy*dy||1)));
    const d=distance(position,{x:a.x+dx*t,y:a.y+dy*t});if(d<best){best=d;index=i;}
  }
  base.splice(index,0,{x:position.x,y:position.y});return base;
}
export function translateConnectionData(data,dx,dy) {
  if(!Array.isArray(data?.waypoints))return data;
  return {...data,waypoints:data.waypoints.map(p=>({x:p.x+dx,y:p.y+dy}))};
}
export function moveInternalConnectionRoutes(previous,next) {
  const before=new Map(previous.nodes.map(n=>[n.id,n])),after=new Map(next.nodes.map(n=>[n.id,n]));
  return {...next,edges:next.edges.map(edge=>{
    const a=before.get(edge.source),b=before.get(edge.target),c=after.get(edge.source),d=after.get(edge.target);
    if(!a||!b||!c||!d)return edge;
    const dx=c.position.x-a.position.x,dy=c.position.y-a.position.y;
    return (dx||dy)&&Math.abs(d.position.x-b.position.x-dx)<.001&&Math.abs(d.position.y-b.position.y-dy)<.001?{...edge,data:translateConnectionData(edge.data,dx,dy)}:edge;
  })};
}
