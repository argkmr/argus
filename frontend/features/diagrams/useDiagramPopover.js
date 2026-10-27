"use client";
import { useCallback, useEffect, useRef } from 'react';

// Non-modal tools should not take canvas space or trap focus. Escape/explicit
// dismissal returns to the opener; clicking or tabbing elsewhere keeps focus
// where the user put it. The listener refs keep text edits from refocusing.
export function useDiagramPopover(open, setOpen, panelRef, triggerRef) {
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, [setOpen, triggerRef]);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const frame = requestAnimationFrame(() => {
      (panel?.querySelector('[data-popover-autofocus]') || panel?.querySelector('button:not(:disabled),input,select'))?.focus();
    });
    const isInside = target => panel?.contains(target) || triggerRef.current?.contains(target);
    const pointer = event => { if (!isInside(event.target)) closeRef.current(false); };
    const focus = event => { if (!isInside(event.target)) closeRef.current(false); };
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('keydown', keyboard, true);
    };
  }, [open, panelRef, triggerRef]);
  return close;
}
