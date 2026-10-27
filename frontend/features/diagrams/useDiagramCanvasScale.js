"use client";

import { useLayoutEffect, useMemo, useState } from 'react';

export function normalizeDiagramBodyZoom(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'normal' || text === 'reset') return 1;
  const number = Number(text.endsWith('%') ? text.slice(0, -1) : text);
  const scale = text.endsWith('%') ? number / 100 : number;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Apply the returned style only to the Studio root, not to the document body.
 * Browser preview uses body CSS zoom for Argus font sizing. Native Electron's
 * webFrame zoom is not CSS zoom and must not be compensated here.
 */
export default function useDiagramCanvasScale() {
  const [bodyZoom, setBodyZoom] = useState(1);
  useLayoutEffect(() => {
    const body = document.body;
    const read = () => setBodyZoom(normalizeDiagramBodyZoom(getComputedStyle(body).zoom));
    read();
    const observer = new MutationObserver(read);
    observer.observe(body, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => ({ '--diagram-body-zoom': bodyZoom }), [bodyZoom]);
}
