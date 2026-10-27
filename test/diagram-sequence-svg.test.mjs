import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { exportStructuredSvg, getStructuredBounds } from '../frontend/features/diagrams/diagram-svg.mjs';
import { getSequenceGeometry, getSequenceLabelLayout, getSequenceEndpointOffset } from '../frontend/features/diagrams/diagram-sequence.mjs';
import { cleanStructured, exportBoard, parseBoardImport, emptySnapshot } from '../frontend/features/diagrams/diagram-model.mjs';

const all = (document, tag) => Array.from(document.getElementsByTagName(tag));
const graph = () => ({ nodes: [
  { id:'client',type:'participant',position:{x:0,y:0},style:{width:180},data:{name:'Customer',role:'Actor',sequence:{rowGap:64,rowCount:9},activations:[{id:'client-work',startRow:0,endRow:7,depth:0}]} },
  { id:'api',type:'participant',position:{x:360,y:0},style:{width:180},data:{name:'Order service',role:'Service',sequence:{rowGap:64,rowCount:9},activations:[{id:'work',startRow:0,endRow:7,depth:0},{id:'nested',startRow:3,endRow:5,depth:1}]} },
],edges:[
  {id:'call',source:'client',target:'api',sourceHandle:'r-0',targetHandle:'l-0',data:{relation:'message',label:'1. Create order with selected items'}},
  {id:'self',source:'api',target:'api',sourceHandle:'r-3',targetHandle:'r-5',data:{relation:'message',label:'2. Validate items'}},
  {id:'return',source:'api',target:'client',sourceHandle:'l-7',targetHandle:'r-7',data:{relation:'return',label:'3. Confirmed'}},
] });
function parse(value) { return new DOMParser().parseFromString(value,'image/svg+xml'); }

test('UML export shares authored activation and endpoint geometry in both themes',()=>{
  for(const theme of [{background:'#151515',foreground:'#e7e7e7'},{background:'#ffffff',foreground:'#18202b'}]) {
    const board=graph(),doc=parse(exportStructuredSvg(board,theme));
    const headers=all(doc,'rect').filter(node=>node.hasAttribute('data-sequence-header'));
    assert.equal(headers.length,2);
    assert.notEqual(headers[0].getAttribute('fill'),theme.background);
    const activations=all(doc,'rect').filter(node=>node.hasAttribute('data-sequence-activation'));
    assert.equal(activations.length,3);
    const geometry=getSequenceGeometry(board.nodes[1].data),nested=geometry.activations[1];
    const rect=activations.find(node=>node.getAttribute('data-sequence-activation')==='nested');
    assert.equal(Number(rect.getAttribute('x')),450+nested.xOffset-6);
    assert.equal(Number(rect.getAttribute('y')),nested.y);
    assert.equal(Number(rect.getAttribute('height')),nested.height);
    const edge=id=>all(doc,'g').find(node=>node.getAttribute('data-edge-id')===id).getElementsByTagName('path')[0];
    const from=getSequenceEndpointOffset(board.nodes[0].data,'r-0'),to=getSequenceEndpointOffset(board.nodes[1].data,'l-0');
    assert.equal(edge('call').getAttribute('d'),`M${90+from.xOffset} ${from.y} L${450+to.xOffset} ${to.y}`);
    assert.equal(edge('call').getAttribute('marker-end'),'url(#argus-sequence-arrow)');
    assert.equal(edge('return').getAttribute('marker-end'),'url(#argus-sequence-open-arrow)');
    assert.equal(edge('return').getAttribute('stroke-dasharray'),'7 5');
    assert.match(edge('self').getAttribute('d'),/^M 462 330 H [\d.]+ V 458 H 462$/);
    const selfLabel=all(doc,'g').find(node=>node.getAttribute('data-edge-label')==='self').getElementsByTagName('rect')[0];
    assert.ok(Number(selfLabel.getAttribute('x'))>=472,'self-call caption does not mask its source activation');
  }
});

test('long sequence labels remain complete, selectable and above the message line',()=>{
  const board=graph();
  const label='1. Validate inventory, delivery options, customer permissions and payment configuration before accepting the order';
  board.edges[0].data.label=label;
  const doc=parse(exportStructuredSvg(board)),caption=all(doc,'g').find(node=>node.getAttribute('data-edge-label')==='call');
  const text=caption.getElementsByTagName('text')[0],rect=caption.getElementsByTagName('rect')[0];
  const layout=getSequenceLabelLayout(label,348);
  assert.equal(text.getAttribute('font-size'),'13');
  assert.deepEqual(all(text,'tspan').map(node=>node.textContent),layout.lines);
  assert.equal(all(text,'tspan').map(node=>node.textContent).join(''),label);
  assert.ok(Number(rect.getAttribute('y'))+Number(rect.getAttribute('height'))<=130,'label clears first arrow at138');
  assert.equal(all(doc,'foreignObject').length,0);
  assert.ok(getStructuredBounds(board).y<=Number(rect.getAttribute('y')),'raster bounds include tall labels');
});

test('existing boards retain rows and acquire no invented execution intervals',()=>{
  const board=graph();
  for(const node of board.nodes){delete node.data.sequence;delete node.data.activations;}
  const doc=parse(exportStructuredSvg(board));
  assert.equal(all(doc,'rect').filter(node=>node.hasAttribute('data-sequence-activation')).length,0);
  const self=all(doc,'g').find(node=>node.getAttribute('data-edge-id')==='self').getElementsByTagName('path')[0];
  assert.match(self.getAttribute('d'),/^M 454 184 H [\d.]+ V 240 H 454$/);
});

test('authored UML sequence round-trips without changing exported geometry',()=>{
  const structured=cleanStructured(graph()),snapshot={...emptySnapshot(),structured};
  const imported=parseBoardImport(exportBoard({name:'Order sequence',snapshot}));
  assert.deepEqual(imported.snapshot.structured,structured);
  assert.equal(exportStructuredSvg(imported.snapshot.structured),exportStructuredSvg(structured));
});
