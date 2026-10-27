// Original, vendor-neutral architecture symbols. These describe concepts,
// rather than claiming to be official logos for any service or provider.
// The same drawing primitives are consumed by React and portable SVG exports.
const primitive = (tag, attrs, text) => Object.freeze({ tag, attrs: Object.freeze(attrs), ...(text ? { text } : {}) });
const path = d => primitive('path', { d });
const circle = (cx, cy, r) => primitive('circle', { cx, cy, r });
const text = (value, x, y) => primitive('text', { x, y, fill: 'currentColor', stroke: 'none', fontFamily: 'Arial, sans-serif', fontSize: 12, fontWeight: 700, textAnchor: 'middle' }, value);
const shard = x => [primitive('ellipse', { cx: x, cy: 27, rx: 6, ry: 2.6 }), path(`M${x - 6} 27v13c0 3.5 12 3.5 12 0V27M${x - 6} 33.5c0 3.5 12 3.5 12 0`)];

export const ARCHITECTURE_SYMBOLS = Object.freeze({
  sharding: Object.freeze({ viewBox: '0 0 48 48', size: 48, primitives: Object.freeze([
    circle(24, 4, 2), path('M24 6v8M8 22v-8h32v8M24 14v8M5 19l3 3 3-3M21 19l3 3 3-3M37 19l3 3 3-3'),
    ...shard(8), ...shard(24), ...shard(40),
  ]) }),
  'consistent-hashing': Object.freeze({ viewBox: '0 0 48 48', size: 48, primitives: Object.freeze([
    primitive('circle', { cx: 24, cy: 24, r: 17, strokeDasharray: '3 3' }),
    circle(24, 7, 3), circle(41, 24, 3), circle(24, 41, 3), circle(7, 24, 3),
    circle(15, 20, 3), path('M18 20h9m-5 0v3m5-3v2M29 20h4l5 4m-5-1 5 1-1-5'),
    path('M31 35a13 13 0 0 0 4-4m-4 1 4-1-1 4'),
  ]) }),
  'load-balancer-l4': Object.freeze({ viewBox: '0 0 48 48', size: 48, primitives: Object.freeze([
    circle(24, 3, 2), path('M24 5v7m-3-3 3 3 3-3'),
    primitive('rect', { x: 12, y: 13, width: 24, height: 16, rx: 4 }), text('L4', 24, 25),
    path('M24 29v6M8 41v-6h32v6M24 35v6M5 38l3 3 3-3M21 38l3 3 3-3M37 38l3 3 3-3'),
    circle(8, 44, 2), circle(24, 44, 2), circle(40, 44, 2),
  ]) }),
  'load-balancer-l7': Object.freeze({ viewBox: '0 0 48 48', size: 48, primitives: Object.freeze([
    primitive('rect', { x: 2, y: 2, width: 13, height: 10, rx: 1.5 }), path('M5 5h7M5 8h4M15 7h9v4m-3-3 3 3 3-3'),
    path('M24 11l14 13-14 13-14-13Z'), text('L7', 24, 28),
    path('M38 24h3v15m-3-4 3 4 3-4M24 37v6H12m3-3-3 3 3 3'),
    primitive('rect', { x: 2, y: 39, width: 10, height: 7, rx: 1.5 }),
    primitive('rect', { x: 36, y: 39, width: 10, height: 7, rx: 1.5 }),
  ]) }),
});

export const getArchitectureSymbol = role => ARCHITECTURE_SYMBOLS[role] || null;
