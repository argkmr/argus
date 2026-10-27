"use client";

import { createContext, createElement, memo, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, NodeResizer, Position, useUpdateNodeInternals } from "@xyflow/react";
import { COMPONENT_BRAND_ICONS, getDiagramComponent } from "./diagram-catalog.mjs";
import { getReplicaLayout } from "./diagram-replicas.mjs";
import { useDiagramPopover } from "./useDiagramPopover";
import { getVisualGeometry } from "./diagram-visuals.mjs";
import { getArchitectureSymbol } from "./diagram-architecture-symbols.mjs";
import { getExpandedNotesLayout } from "./diagram-expanded-layout.mjs";
import { getSequenceEndpointOffset, getSequenceGeometry } from "./diagram-sequence.mjs";
import { getCachedEraserIcon, isCachedEraserIconMonochrome, loadEraserIcon } from "./eraser-icon-assets.mjs";
import "./diagram-nodes.css";

export const DiagramNodeActionsContext = createContext({
  updateNode() {},
  addMember() {},
  removeMember() {},
});

export const SEQUENCE_MESSAGE_ROWS = Object.freeze(getSequenceGeometry().rows);

function stopEditingKey(event) {
  if (event.key !== "Escape") event.stopPropagation();
}

function stopPropagation(event) { event.stopPropagation(); }

const editingProps = {
  // XYFlow checks nokey during capture, before these inputs can stop a
  // Shift-drag event. Keep text selection separate from box selection.
  className: "diagram-inline-input nodrag nopan nowheel nokey",
  autoComplete: "off",
  spellCheck: false,
  onKeyDown: stopEditingKey,
  onPointerDown: stopPropagation,
  onClick: stopPropagation,
  onDoubleClick: stopPropagation,
};

function RoleGlyph({ role, size = 24 }) {
  const architectureSymbol = getArchitectureSymbol(role);
  if (architectureSymbol) return <svg className="diagram-role-glyph" data-architecture-symbol={role} width={size} height={size} viewBox={architectureSymbol.viewBox} fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{architectureSymbol.primitives.map(({ tag, attrs, text }, index) => createElement(tag, { ...attrs, key: index }, text))}</svg>;
  let drawing;
  switch (role) {
    case "database":
      drawing = <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>;
      break;
    case "cache":
      drawing = <><path d="m3 6 9-4 9 4-9 4-9-4Zm0 6 9 4 9-4M3 18l9 4 9-4" /><path d="m13 8-3 5h4l-3 5" /></>;
      break;
    case "topic":
      drawing = <><rect x="2" y="3" width="20" height="5" rx="1" /><rect x="2" y="10" width="20" height="5" rx="1" /><rect x="2" y="17" width="20" height="5" rx="1" /><path d="M7 3v5m6-5v5m5-5v5M7 10v5m6-5v5m5-5v5M7 17v5m6-5v5m5-5v5" /></>;
      break;
    case "queue":
      drawing = <><path d="M4 4h16M4 20h16m0-16a3 8 0 0 1 0 16" /><ellipse cx="4" cy="12" rx="3" ry="8" /><path d="M9 9v6m4-6v6m4-6v6" /></>;
      break;
    case "load-balancer":
      drawing = <><path d="M12 2v5M4 14v-4h16v4M12 7v7" /><rect x="1" y="15" width="6" height="6" rx="1" /><rect x="9" y="15" width="6" height="6" rx="1" /><rect x="17" y="15" width="6" height="6" rx="1" /></>;
      break;
    case "gateway":
      drawing = <><rect x="8" y="3" width="8" height="18" rx="2" /><path d="M1 8h7M1 16h7m8-8h7m-7 8h7m-12-9v10m3-10v10" /></>;
      break;
    case "browser":
    case "client":
      drawing = <><rect x="2" y="3" width="20" height="18" rx="2" /><path d="M2 8h20m-16-3h.01M9 5h.01M7 12l-3 3 3 3m10-6 3 3-3 3" /></>;
      break;
    case "mobile":
      drawing = <><rect x="6" y="1" width="12" height="22" rx="2" /><path d="M10 4h4m-3 16h2" /></>;
      break;
    case "user":
      drawing = <><circle cx="12" cy="6" r="4" /><path d="M4 22v-3a8 8 0 0 1 16 0v3M4 22h16" /></>;
      break;
    case "cloud":
    case "external":
      drawing = <><path d="M6 19a5 5 0 1 1 .6-10A6 6 0 0 1 18 8a5.5 5.5 0 0 1 0 11H6Z" />{role === "external" && <path d="M10 15h5m-2-2 2 2-2 2" />}</>;
      break;
    case "object-store":
      drawing = <><path d="M4 6h16l-2 15H6L4 6Zm0 0 3-4h10l3 4M9 11h6v5H9z" /></>;
      break;
    case "container":
      drawing = <><path d="m12 2 10 5v10l-10 5-10-5V7l10-5Zm0 10 10-5M12 12 2 7m10 5v10M7 4l10 5" /></>;
      break;
    case "cluster":
      drawing = <><rect x="8" y="1" width="8" height="7" rx="1" /><rect x="1" y="16" width="8" height="7" rx="1" /><rect x="15" y="16" width="8" height="7" rx="1" /><path d="M12 8v5H5v3m7-3h7v3" /></>;
      break;
    case "monitor":
    case "chart":
      drawing = <><rect x="2" y="3" width="20" height="16" rx="2" /><path d="M8 23h8m-4-4v4" />{role === "monitor" ? <path d="M5 11h3l2-5 4 10 2-5h3" /> : <path d="M6 15v-3m4 3V9m4 6V6m4 9v-5" />}</>;
      break;
    case "worker":
      drawing = <><path d="m12 2 3 2 4 1 1 4 2 3-2 3-1 4-4 1-3 2-3-2-4-1-1-4-2-3 2-3 1-4 4-1 3-2Z" /><path d="m10 8 6 4-6 4V8Z" /></>;
      break;
    default:
      drawing = <><rect x="3" y="2" width="18" height="8" rx="2" /><rect x="3" y="14" width="18" height="8" rx="2" /><path d="M7 6h.01M7 18h.01M11 6h6m-6 12h6M12 10v4" /></>;
  }
  return <svg className="diagram-role-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{drawing}</svg>;
}

function EraserIcon({ name, label, size, monochrome }) {
  const cachedAsset = () => ({ name, url: getCachedEraserIcon(name), monochrome: isCachedEraserIconMonochrome(name), error: false });
  const [asset, setAsset] = useState(cachedAsset);
  useEffect(() => {
    let active = true;
    setAsset(cachedAsset());
    const load = options => loadEraserIcon(name, options).then(url => { if (active) setAsset({ name, url, monochrome: isCachedEraserIconMonochrome(name), error: false }); }, () => { if (active) setAsset({ name, url: null, error: true }); });
    const reconnect = () => load({ retry: true });
    load();
    window.addEventListener('online', reconnect);
    return () => { active = false; window.removeEventListener('online', reconnect); };
  }, [name]);
  if (asset.name === name && asset.url) return (asset.monochrome ?? monochrome)
    ? <span className="diagram-eraser-icon diagram-eraser-monochrome" style={{ width: size, height: size, maskImage: `url("${asset.url}")`, WebkitMaskImage: `url("${asset.url}")` }} aria-hidden="true" />
    : <img className="diagram-eraser-icon" src={asset.url} width={size} height={size} alt="" draggable={false} />;
  return <span className={`diagram-icon-placeholder ${asset.error ? 'is-unavailable' : ''}`} style={{ width: size, height: size }} role="img" aria-label={asset.error ? `${label} icon unavailable; reconnect to load it` : `Loading ${label} icon`} title={asset.error ? 'Icon unavailable. Reconnect to load it, or reopen the board to retry.' : 'Loading icon…'}><svg width={size} height={size} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="6" y="6" width="36" height="36" rx="8" strokeDasharray="3 4" />{asset.error ? <path d="M24 15v12m0 5h.01" /> : <circle cx="24" cy="24" r="7" strokeDasharray="20 24" />}</svg></span>;
}

function VisualOutline({ component, width, height, className = '' }) {
  const preview = width < 80 || height < 80;
  const geometry = getVisualGeometry(component, preview ? component.width : width, preview ? component.height : height);
  return <svg className={`diagram-visual-outline ${className}`} width={width} height={height} viewBox={`0 0 ${geometry.width} ${geometry.height}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">{geometry.primitives.map(({ tag, attrs }, index) => createElement(tag, { ...attrs, vectorEffect: 'non-scaling-stroke', key: index }))}</svg>;
}

export function ComponentGlyph({ componentKey, size = 28, role, className = "" }) {
  const component = getDiagramComponent(componentKey);
  const icon = component.brand && COMPONENT_BRAND_ICONS[component.brand];
  const badgeSize = Math.round(size * (size >= 48 ? .375 : .44));
  if (component.iconName) return <span className={`diagram-component-glyph has-eraser-icon ${className}`} style={{ '--component-glyph-size': `${size}px` }} title={component.label}><EraserIcon name={component.iconName} label={component.label} size={size} monochrome={component.monochrome} /></span>;
  if (component.visualKind) return <span className={`diagram-component-glyph has-visual ${className}`} style={{ '--component-glyph-size': `${size}px` }} title={component.label}><VisualOutline component={component} width={size} height={size} /></span>;
  return <span className={`diagram-component-glyph ${icon ? "has-brand" : ""} ${className}`.trim()} style={{ "--component-color": component.color, "--component-glyph-size": `${size}px`, "--component-badge-size": `${badgeSize}px` }} title={icon ? `${role || component.role} · ${icon.title} product icon` : `${role || component.role} symbol`}>
    <RoleGlyph role={role || component.role} size={size} />
    {icon && <svg className="diagram-brand-glyph" width={badgeSize} height={badgeSize} viewBox={icon.viewBox || "0 0 24 24"} fill={component.color} aria-hidden="true">{icon.paths ? icon.paths.map(({ d, fill }, index) => <path key={index} d={d} fill={fill} />) : <path d={icon.path} />}</svg>}
  </span>;
}

function ConnectionHandles({ isConnectable, ports }) {
  return <>{[["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]].map(([id, position]) => <Handle key={id} id={id} type="source" position={position} isConnectable={isConnectable} className="diagram-node-handle" aria-label={`${id} connection`} style={ports ? { left: ports[id][0], top: ports[id][1], right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)' } : undefined} />)}</>;
}

function ResizeFrame({ selected, minWidth, minHeight, ...props }) {
  return <NodeResizer isVisible={selected} minWidth={minWidth} minHeight={minHeight} handleClassName="diagram-resize-handle" lineClassName="diagram-resize-line" {...props} />;
}

function MemberCompartment({ nodeId, className, section, members, actions }) {
  const container = useRef(null);
  const focusNewMember = useRef(false);
  const singular = section === "fields" ? "field" : "method";
  useEffect(() => {
    if (!focusNewMember.current) return;
    const inputs = container.current?.querySelectorAll("input");
    if (inputs?.length) {
      inputs[inputs.length - 1].focus();
      inputs[inputs.length - 1].select();
    }
    focusNewMember.current = false;
  }, [members.length]);
  return <section ref={container} className={`diagram-class-compartment diagram-class-${section}`} aria-label={`${className || "Class"} ${section}`}>
    <div className="diagram-compartment-heading">
      <span>{section === "fields" ? "Fields" : "Methods"}</span>
      <button className="diagram-member-add nodrag nopan nokey" type="button" disabled={members.length >= 100} aria-label={`Add ${singular} to ${className || "class"}`} title={members.length >= 100 ? `Limit of 100 ${section}` : `Add ${singular}`} onPointerDown={stopPropagation} onKeyDown={stopEditingKey} onClick={(event) => { event.stopPropagation(); focusNewMember.current = true; actions.addMember(nodeId, section); }}>+</button>
    </div>
    {members.map((member, index) => <div className="diagram-member-row" key={member.id}>
      <input {...editingProps} maxLength={2000} aria-label={`${singular === "field" ? "Field" : "Method"} ${index + 1} in ${className || "class"}`} value={member.text || ""} placeholder={section === "fields" ? "+ field: Type" : "+ method(): Type"} onChange={(event) => actions.updateNode(nodeId, { [section]: members.map((current) => current.id === member.id ? { ...current, text: event.target.value } : current) })} />
      <button className="diagram-member-remove nodrag nopan nokey" type="button" aria-label={`Remove ${singular} ${index + 1} from ${className || "class"}`} title={`Remove ${singular}`} onPointerDown={stopPropagation} onKeyDown={stopEditingKey} onClick={(event) => { event.stopPropagation(); actions.removeMember(nodeId, section, member.id); }}>−</button>
    </div>)}
    {!members.length && <span className="diagram-compartment-empty">No {section}</span>}
  </section>;
}

export const UMLClassNode = memo(function UMLClassNode({ id, data, selected, isConnectable }) {
  const actions = useContext(DiagramNodeActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const methods = Array.isArray(data.methods) ? data.methods : [];
  useEffect(() => { updateNodeInternals(id); }, [id, fields.length, methods.length, updateNodeInternals]);
  const minHeight = 146 + Math.max(1, fields.length) * 28 + Math.max(1, methods.length) * 28;
  return <div className={`diagram-node diagram-class-node ${selected ? "is-selected" : ""}`} style={{ minHeight }}>
    <ResizeFrame selected={selected} minWidth={260} minHeight={minHeight} />
    <ConnectionHandles isConnectable={isConnectable} />
    <header className="diagram-class-header">
      <div className="diagram-stereotype"><span>«</span><input {...editingProps} maxLength={120} aria-label="Class stereotype" value={data.stereotype || ""} placeholder="class" onChange={(event) => actions.updateNode(id, { stereotype: event.target.value })} /><span>»</span></div>
      <input {...editingProps} maxLength={240} className={`${editingProps.className} diagram-node-name`} aria-label="Class name" value={data.name || ""} placeholder="ClassName" onChange={(event) => actions.updateNode(id, { name: event.target.value })} />
    </header>
    <MemberCompartment nodeId={id} className={data.name} section="fields" members={fields} actions={actions} />
    <MemberCompartment nodeId={id} className={data.name} section="methods" members={methods} actions={actions} />
  </div>;
});

export const ComponentNode = memo(function ComponentNode({ id, data, selected, isConnectable, width = 240, height = 160 }) {
  const { updateNode, readOnly = false, expandedNotes = false } = useContext(DiagramNodeActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const component = getDiagramComponent(data.componentKey);
  const replicas = getReplicaLayout(data.replicas);
  const name = data.name || component.label;
  const visual = component.visualKind ? getVisualGeometry(component, width, height) : null;
  const expanded = data.expandedNotes && !visual ? getExpandedNotesLayout(data) : null;
  const ports = expanded ? { top:[60,0], right:[expanded.width,56], bottom:[60,expanded.height], left:[0,56] } : visual?.ports;
  useEffect(() => { updateNodeInternals(id); }, [id, component.id, width, height, updateNodeInternals]);
  const [draftCount, setDraftCount] = useState(String(replicas.count));
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => { if (expanded) setNotesOpen(false); }, [Boolean(expanded)]);
  const [notesPosition, setNotesPosition] = useState(null);
  const notesTrigger = useRef(null), notesPanel = useRef(null);
  const closeNotes = useDiagramPopover(notesOpen, setNotesOpen, notesPanel, notesTrigger);
  // A screen-space portal keeps notes usable when a large architecture is
  // zoomed out. It never changes the node's measured size or connection ports.
  useEffect(() => {
    if (!notesOpen) return;
    const place = () => {
      const trigger = notesTrigger.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const height = Math.min(332, window.innerHeight - 24);
      const bodyZoom = Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
      const colors = getComputedStyle(trigger), theme = {};
      for (const key of ['--text', '--muted', '--muted-2', '--surface', '--surface-2', '--line', '--accent']) theme[key] = colors.getPropertyValue(key);
      setNotesPosition({ ...theme, zoom: 1 / bodyZoom, width, maxHeight: height, left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right + 10)), top: Math.max(12, Math.min(window.innerHeight - height - 12, rect.top)) });
    };
    place();
    const observer = new MutationObserver(place);
    // Both desktop and the shared web canvas switch theme on an ancestor.
    // Observe attributes only so note edits cannot cause a positioning loop.
    for (let ancestor = notesTrigger.current?.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [notesOpen]);
  useEffect(() => { setDraftCount(String(replicas.count)); }, [replicas.count]);
  const changeCount = (value) => {
    if (readOnly) return;
    const count = getReplicaLayout(value).count;
    setDraftCount(String(count));
    if (count !== replicas.count) updateNode(id, { replicas: count });
  };
  const notesButton = <button ref={notesTrigger} className={`diagram-component-notes-trigger nodrag nopan nokey ${data.description?.trim() ? 'has-notes' : ''}`} type="button" title={data.description?.trim() ? 'View component notes' : 'Add component notes'} aria-label={`Notes for ${name}`} aria-haspopup="dialog" aria-expanded={notesOpen} aria-controls={`component-notes-${id}`} onPointerDown={stopPropagation} onKeyDown={stopEditingKey} onClick={event => { event.stopPropagation(); setNotesOpen(open => !open); }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 3h14v13l-5 5H5z M14 21v-5h5 M8 8h8 M8 12h6" /></svg>
  </button>;
  return <div className={`diagram-node diagram-architecture-node ${visual ? 'diagram-visual-node' : ''} ${expanded ? 'has-expanded-notes' : ''} ${component.role === "queue" ? "is-queue-component" : ""} ${replicas.count > 1 ? "has-replicas" : ""} ${selected ? "is-selected" : ""}`} data-visual-kind={component.visualKind} data-visual-form={component.shape || component.frame} style={{ "--component-color": component.color }}>
    <ResizeFrame selected={selected && !readOnly && !expandedNotes} minWidth={180} minHeight={160} />
    <ConnectionHandles isConnectable={!expandedNotes && isConnectable} ports={ports} />
    {visual ? <div className="diagram-visual-face">
      <VisualOutline component={component} width={width} height={height} />
      <textarea {...editingProps} readOnly={readOnly} rows={2} maxLength={240} className={`${editingProps.className} diagram-node-name diagram-visual-label`} style={{ left: visual.label.x, top: visual.label.y, width: visual.label.width, height: visual.label.height }} aria-label="Component name" title={name} value={data.name || ''} placeholder={component.label} onChange={event => { if (!readOnly) updateNode(id, { name: event.target.value }); }} />
      {notesButton}
    </div> : <div className="diagram-architecture-face">
    <div className="diagram-architecture-symbol" style={expanded?{left:expanded.glyphX,top:expanded.glyphY}:undefined}>
      <div className="diagram-replica-layers" aria-hidden="true">{replicas.offsets.map(offset => <span key={offset} style={{ transform: `translate(${-offset}px, ${-offset}px)` }}><ComponentGlyph componentKey={data.componentKey} size={64} /></span>)}</div>
      <ComponentGlyph componentKey={data.componentKey} size={64} />
      {!expanded && notesButton}
    </div>
    <textarea {...editingProps} readOnly={readOnly} rows={expanded?expanded.nameLines.length:2} maxLength={240} className={`${editingProps.className} diagram-node-name`} style={expanded?{left:4,top:expanded.nameTop,width:expanded.nameWidth,height:expanded.nameLines.length*expanded.lineHeight,minHeight:expanded.nameLines.length*expanded.lineHeight,padding:0,fontSize:expanded.nameFontSize,lineHeight:`${expanded.lineHeight}px`}:undefined} aria-label="Component name" title={name} value={data.name || ""} placeholder={component.label} onChange={(event) => { if (!readOnly) updateNode(id, { name: event.target.value }); }} />
      {expanded && <textarea {...editingProps} className={`${editingProps.className} diagram-component-inline-notes`} readOnly={readOnly} aria-label={`Expanded notes for ${name}`} maxLength={4000} value={data.description || ''} placeholder={readOnly?'No notes yet.':'Add responsibilities, decisions, or configuration…'} style={{left:expanded.notesX,top:expanded.notesTop,width:expanded.notesWidth,height:Math.max(3,expanded.notesLines.length)*expanded.lineHeight,fontSize:expanded.notesFontSize,lineHeight:`${expanded.lineHeight}px`}} onChange={event=>{if(!readOnly)updateNode(id,{description:event.target.value});}}/>}
      <div className="diagram-replica-count nodrag nopan nowheel nokey" style={expanded?{left:31,top:expanded.replicaTop}:undefined} title={`${replicas.count} ${replicas.count === 1 ? "instance" : "instances"}${readOnly ? '' : ' · edit replica count'}`}>
        <span aria-hidden="true">×</span><input {...editingProps} readOnly={readOnly} className={`${editingProps.className} diagram-replica-input`} type="number" min="1" max="1000" step="1" aria-label={`Replica count for ${name}`} value={draftCount} onChange={event => { if (readOnly) return; const value = event.target.value; setDraftCount(value); if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1000) updateNode(id, { replicas: Number(value) }); }} onBlur={() => changeCount(draftCount)} onKeyDown={event => { stopEditingKey(event); if (event.key === "Enter") { changeCount(draftCount); event.currentTarget.blur(); } }} />
        <div className="diagram-replica-actions">
          <button className="nodrag nopan" type="button" aria-label={`Remove replica from ${name}`} title="Remove replica" disabled={readOnly || replicas.count <= 1} onPointerDown={stopPropagation} onKeyDown={stopEditingKey} onClick={event => { event.stopPropagation(); changeCount(replicas.count - 1); }}>−</button>
          <button className="nodrag nopan" type="button" aria-label={`Add replica to ${name}`} title="Add replica" disabled={readOnly || replicas.count >= 1000} onPointerDown={stopPropagation} onKeyDown={stopEditingKey} onClick={event => { event.stopPropagation(); changeCount(replicas.count + 1); }}>+</button>
        </div>
      </div>
    </div>}
    {notesOpen && typeof document !== 'undefined' && createPortal(<section ref={notesPanel} id={`component-notes-${id}`} className="diagram-component-notes nodrag nopan nowheel nokey" role="dialog" aria-label={`Notes for ${name}`} style={notesPosition || { left: 12, top: 12, width: 'min(320px, calc(100vw - 24px))' }} onPointerDown={stopPropagation} onClick={stopPropagation} onKeyDown={stopEditingKey}>
      <header><div><strong>{name}</strong><span>{component.label} · {readOnly ? 'Read-only notes' : 'Component notes'}</span></div><button type="button" aria-label="Close component notes" onClick={() => closeNotes()}>×</button></header>
      {readOnly ? <p className="diagram-component-notes-readonly">{data.description || 'No notes yet.'}</p> : <textarea data-popover-autofocus aria-label="Component notes" maxLength={4000} rows={7} value={data.description || ''} placeholder="Responsibilities, configuration, trade-offs…" onChange={event => updateNode(id, { description: event.target.value })} />}
      <footer>{readOnly ? 'Shared with this component' : 'Notes autosave · Esc to close'}</footer>
    </section>, document.body)}
  </div>;
});

export const ParticipantNode = memo(function ParticipantNode({ id, data, selected, isConnectable, width, height }) {
  const { updateNode, readOnly = false } = useContext(DiagramNodeActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const geometry = getSequenceGeometry(data, height);
  const geometryKey = JSON.stringify([geometry.rows, geometry.activations]);
  useEffect(() => { updateNodeInternals(id); }, [id, width, geometry.height, geometryKey, updateNodeInternals]);
  const minimumHeight = getSequenceGeometry(data, 1).height;
  return <div className={`diagram-participant-node ${selected ? "is-selected" : ""}`} data-sequence-layout={data.sequence ? "custom" : "legacy"} data-readonly={readOnly} style={{ height: geometry.height, '--sequence-header-height': `${geometry.headerHeight}px` }}>
    <ResizeFrame selected={selected && !readOnly} minWidth={160} minHeight={minimumHeight} onResizeEnd={(_, dimensions) => { if (!readOnly) updateNode(id, { lifelineHeight: Math.round(dimensions.height - geometry.headerHeight) }); }} />
    <header className="diagram-node diagram-participant-header">
      <input {...editingProps} readOnly={readOnly} maxLength={240} className={`${editingProps.className} diagram-node-name`} aria-label="Participant name" value={data.name || ""} placeholder="Participant" onChange={(event) => { if (!readOnly) updateNode(id, { name: event.target.value }); }} />
      <input {...editingProps} readOnly={readOnly} maxLength={120} className={`${editingProps.className} diagram-participant-role`} aria-label="Participant role" value={data.role || ""} placeholder="Actor or service" onChange={(event) => { if (!readOnly) updateNode(id, { role: event.target.value }); }} />
    </header>
    <div className="diagram-lifeline" aria-hidden="true" />
    {geometry.activations.map(activation => <div key={activation.id} className="diagram-sequence-activation" data-activation-id={activation.id} data-start-row={activation.startRow} data-end-row={activation.endRow} data-depth={activation.depth} style={{ left: `calc(50% + ${activation.xOffset - activation.width / 2}px)`, top: activation.y, width: activation.width, height: activation.height }} aria-hidden="true" />)}
    {geometry.rows.map((row) => {
      const left = getSequenceEndpointOffset(data, row.leftHandle);
      const right = getSequenceEndpointOffset(data, row.rightHandle);
      // React Flow attaches to each handle's outer edge, not its centre. Keep
      // that edge exactly on the activation/lifeline offset shared with SVG.
      return <div className="diagram-message-slot" data-row={row.index} style={{ top: row.y }} key={row.index}>
        <Handle id={row.leftHandle} type="source" position={Position.Left} isConnectable={isConnectable && !readOnly} className="diagram-node-handle diagram-sequence-handle diagram-sequence-handle-left" style={{ left: left?.xOffset ?? -4, right: 'auto', transform: 'translate(0, -50%)' }} aria-label={`Message ${row.index + 1}, left connection`} />
        <span className="diagram-message-row-number" style={{ left: Math.max(16, (right?.xOffset || 0) + 12) }} aria-hidden="true">{row.index + 1}</span>
        <Handle id={row.rightHandle} type="source" position={Position.Right} isConnectable={isConnectable && !readOnly} className="diagram-node-handle diagram-sequence-handle diagram-sequence-handle-right" style={{ left: right?.xOffset ?? 4, right: 'auto', transform: 'translate(-100%, -50%)' }} aria-label={`Message ${row.index + 1}, right connection`} />
      </div>;
    })}
    <div className="diagram-lifeline-end" aria-hidden="true" />
  </div>;
});

export const NoteNode = memo(function NoteNode({ id, data, selected, isConnectable }) {
  const { updateNode } = useContext(DiagramNodeActionsContext);
  return <div className={`diagram-node diagram-note-node ${selected ? "is-selected" : ""}`}>
    <ResizeFrame selected={selected} minWidth={180} minHeight={114} />
    <ConnectionHandles isConnectable={isConnectable} />
    <input {...editingProps} maxLength={240} className={`${editingProps.className} diagram-node-name`} aria-label="Note title" value={data.name || ""} placeholder="Note" onChange={(event) => updateNode(id, { name: event.target.value })} />
    <textarea {...editingProps} maxLength={4000} className={`${editingProps.className} diagram-note-text`} aria-label="Note text" rows={3} value={data.description || ""} placeholder="Add context…" onChange={(event) => updateNode(id, { description: event.target.value })} />
  </div>;
});

export const nodeTypes = Object.freeze({ umlClass: UMLClassNode, component: ComponentNode, participant: ParticipantNode, note: NoteNode });
