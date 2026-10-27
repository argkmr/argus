// Shape paths adapted from Eraser Labs' MIT-licensed diagram templates.
// Upstream: eraserlabs/eraser-diagrams @ 1f5eefd53fa42010dd86321e600d68fdce37b30d.
// Device frames are Argus-authored wireframe geometry, not vendor trademarks.
// See public/licenses/eraser-diagrams-MIT.txt for the upstream notice.
const shapeNames = ['rectangle', 'parallelogram', 'trapezoid', 'diamond', 'cylinder', 'hexagon', 'circle', 'ellipse', 'oval', 'triangle', 'document', 'star'];
const title = value => value[0].toUpperCase() + value.slice(1);
export const DIAGRAM_VISUALS = Object.freeze([
  ...shapeNames.map(shape => ({ id: `shape:${shape}`, label: title(shape), category: 'Shapes', visualKind: 'shape', shape, role: 'shape', color: '#98a7bc', width: ['circle', 'star', 'diamond'].includes(shape) ? 200 : 240, height: ['circle', 'star', 'diamond'].includes(shape) ? 200 : 160, description: `${title(shape)} diagram shape with an editable label and notes` })),
  ...[['phone', 200, 340], ['tablet', 280, 340], ['browser', 360, 240], ['desktop', 360, 260]].map(([frame, width, height]) => ({ id: `frame:${frame}`, label: `${title(frame)} frame`, category: 'Device frames', visualKind: 'frame', frame, role: 'frame', color: '#98a7bc', width, height, description: `${title(frame)} wireframe with an editable label and notes` })),
].map(Object.freeze));

const SHAPE_PATHS = Object.freeze({
  parallelogram: 'M15.3846 0H100L84.6154 100H0Z',
  trapezoid: 'M20.6186 0H79.3814L100 100H0Z',
  diamond: 'M50 0L100 50L50 100L0 50Z',
  hexagon: 'M0 50L25 99.7965H75L100 50L75 .2035H25Z',
  triangle: 'M50 0L0 100H100Z',
  star: 'M50 0L66.1641 28.3024L97.5528 38.0041L76.1541 65.1976L79.3893 99.4959L50 88L20.6107 99.4959L23.8459 65.1976L2.4472 38.0041L33.8359 28.3024Z',
  document: 'M.87 6.67C.87 3.47 3.41 1 6.53 1H93.3C96.4 1 99 3.51 99 7V77.7C98.9 86.3 95.1 89.9 91.3 88.8C85.1 87.1 76.1 85.1 68.5 85.1C55.4 98.1 44.3 98.1 28 98.1C15.2 98.1 5.9 90.8 2.45 87.6C.87 86.7 .87 85.2 .87 83.9V6.67Z',
  cylinder: 'M0 11V89A50 11 0 0 0 100 89V11A50 11 0 0 0 0 11Z',
});

/** Pixel geometry shared by live nodes, picker previews and portable SVGs. */
export function getVisualGeometry(component, width, height) {
  const w = Math.max(20, Number(width) || 240), h = Math.max(20, Number(height) || 160);
  const inset = 2, x = inset, y = inset, bw = w - 4, bh = h - 4;
  const primitives = [], add = (tag, attrs) => primitives.push({ tag, attrs });
  let label = { x: w * .16, y: h / 2 - 22, width: w * .68, height: 44 };
  let ports = { top: [w / 2, y], right: [w - inset, h / 2], bottom: [w / 2, h - inset], left: [x, h / 2] };
  if (component.visualKind === 'frame') {
    const frame = component.frame;
    if (frame === 'phone' || frame === 'tablet') {
      const radius = frame === 'phone' ? Math.min(24, w / 8) : 14;
      add('rect', { x, y, width: bw, height: bh, rx: radius });
      add('path', { d: `M${w / 2 - 17} 14h34M${w / 2 - 18} ${h - 13}h36` });
      add('rect', { x: 10, y: 28, width: w - 20, height: h - 54, rx: frame === 'phone' ? 12 : 5, opacity: .35 });
      label = { x: 22, y: h / 2 - 22, width: w - 44, height: 44 };
    } else if (frame === 'browser') {
      add('rect', { x, y, width: bw, height: bh, rx: 9 });
      add('path', { d: `M2 36H${w - 2}` });
      for (const cx of [15, 26, 37]) add('circle', { cx, cy: 19, r: 2 });
      add('rect', { x: 52, y: 11, width: Math.max(30, w - 98), height: 16, rx: 4, opacity: .4 });
      label = { x: 20, y: h / 2 - 4, width: w - 40, height: 44 };
    } else {
      const screenBottom = h - 40;
      add('rect', { x, y, width: bw, height: screenBottom - y, rx: 9 });
      add('path', { d: `M2 ${screenBottom - 22}H${w - 2}M${w / 2 - 20} ${screenBottom}l-6 28h52l-6-28M${w / 2 - 46} ${h - 4}h92` });
      label = { x: 20, y: (screenBottom - 22) / 2 - 22, width: w - 40, height: 44 };
      ports = { top: [w / 2, y], right: [w - inset, screenBottom / 2], bottom: [w / 2, h - 4], left: [x, screenBottom / 2] };
    }
  } else {
    const shape = component.shape;
    if (shape === 'circle') {
      const radius = Math.min(bw, bh) / 2;
      add('circle', { cx: w / 2, cy: h / 2, r: radius });
      ports = { top: [w / 2, h / 2 - radius], right: [w / 2 + radius, h / 2], bottom: [w / 2, h / 2 + radius], left: [w / 2 - radius, h / 2] };
      label.width = radius * 1.4; label.x = (w - label.width) / 2;
    } else if (shape === 'ellipse') add('ellipse', { cx: w / 2, cy: h / 2, rx: bw / 2, ry: bh / 2 });
    else if (shape === 'oval') add('rect', { x, y, width: bw, height: bh, rx: Math.min(bw, bh) / 2 });
    else if (SHAPE_PATHS[shape]) {
      const transform = `translate(2 2) scale(${bw / 100} ${bh / 100})`;
      add('path', { d: SHAPE_PATHS[shape], transform });
      if (shape === 'cylinder') add('path', { d: 'M0 11A50 11 0 0 0 100 11', transform, fill: 'none' });
      if (shape === 'triangle') { ports.left = [x + bw / 4, h / 2]; ports.right = [x + bw * .75, h / 2]; label = { x: w * .25, y: h * .55, width: w * .5, height: 44 }; }
      if (shape === 'parallelogram') { ports.left[0] = x + bw * .076923; ports.right[0] = x + bw * .923077; }
      if (shape === 'trapezoid') { ports.left[0] = x + bw * .103093; ports.right[0] = x + bw * .896907; }
      if (shape === 'star') { label.x = w * .28; label.width = w * .44; ports.right = [x + bw * .88113, h / 2]; ports.left = [x + bw * .11887, h / 2]; ports.bottom[1] = y + bh * .88; }
      if (shape === 'diamond') { label.x = w * .25; label.width = w * .5; }
      if (shape === 'document') { label.y = h * .38; ports.bottom[1] = y + bh * .95; }
    } else add('rect', { x, y, width: bw, height: bh, rx: 6 });
  }
  return { width: w, height: h, primitives, label, ports };
}
