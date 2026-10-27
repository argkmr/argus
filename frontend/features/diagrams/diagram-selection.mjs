import { sanitizeGroupMembership } from './diagram-groups.mjs';

/** Selection is local UI state, not a document edit or an undo entry. */
export function selectDiagramElements(graph, selected = true) {
  let changed = false;
  const update = item => {
    const next = Boolean(selected) && item.selectable !== false;
    if (Boolean(item.selected) === next) return item;
    changed = true;
    return { ...item, selected: next };
  };
  const nodes = graph.nodes.map(update), edges = graph.edges.map(update);
  return changed ? { ...graph, nodes, edges } : graph;
}

/** Delete only selected objects/connections; a frame never implies deleting its members. */
export function deleteDiagramSelection(graph) {
  const removed = new Set(graph.nodes.filter(node => node.selected).map(node => node.id));
  if (!removed.size && !graph.edges.some(edge => edge.selected)) return graph;
  return {
    ...graph,
    nodes: removed.size ? sanitizeGroupMembership(graph.nodes.filter(node => !removed.has(node.id))) : graph.nodes,
    edges: graph.edges.filter(edge => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)),
  };
}

/** React portals bubble through the canvas tree; containment is required before any shortcut. */
export function isDiagramShortcutTarget(event, root) {
  const target = event?.target;
  if (!root || !target || !root.contains?.(target) || event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing) return false;
  if (root.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
  if (target.isContentEditable || target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],[role="alertdialog"],.nokey,.diagram-edge-inspector,[data-diagram-shortcuts-ignore]')) return false;
  return true;
}
