export const FONT_SIZE_ZOOM = Object.freeze({ compact: 1.04, comfortable: 1.12, large: 1.22 });

export function normalizeFontSize(value) {
  return Object.hasOwn(FONT_SIZE_ZOOM, value) ? value : "comfortable";
}

export function fontSizeZoom(value) {
  return FONT_SIZE_ZOOM[normalizeFontSize(value)];
}
