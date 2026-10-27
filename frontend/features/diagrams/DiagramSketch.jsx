"use client";

import { Component, useCallback, useEffect, useRef } from "react";
import {
  CaptureUpdateAction, Excalidraw, MainMenu, MIME_TYPES, WelcomeScreen,
  loadLibraryFromBlob, loadSceneOrLibraryFromBlob, restoreElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  assertLocalSketchData, sanitizeSketchSnapshot, sanitizeSketchFiles, sanitizeSketchLink,
  sanitizeSketchElements as localElements, sanitizeSketchLibrary as localLibrary,
  sanitizeSketchAppState as savedAppState,
} from "./diagram-sketch-model.mjs";

if (typeof window !== "undefined") {
  window.EXCALIDRAW_ASSET_PATH = "/assets/excalidraw/";
}

const UI_OPTIONS = {
  canvasActions: { export: { saveFileToDisk: true }, toggleTheme: false, loadScene: false },
  tools: { image: true },
};
const NO_EMBED = () => <></>;

function containsHtmlWidget(value) {
  if (!value || typeof value !== "object") return false;
  return value.type === "iframe" || value.type === "magicframe"
    || Object.values(value).some(containsHtmlWidget);
}

function elementStamp(elements = []) {
  return JSON.stringify(elements.map((element) => [
    element.id, element.version, element.versionNonce, element.index, element.isDeleted, element.link,
  ]));
}

function libraryStamp(items = []) {
  return JSON.stringify(items.map((item) => [
    item.id, item.status, item.created, item.name, elementStamp(item.elements),
  ]));
}

function sameFiles(previous = {}, next = {}) {
  const ids = Object.keys(next);
  return ids.length === Object.keys(previous).length && ids.every((id) => {
    const a = previous[id];
    const b = next[id];
    return a && a.id === b.id && a.dataURL === b.dataURL && a.mimeType === b.mimeType
      && a.created === b.created && a.version === b.version;
  });
}

class SketchErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onError?.(error.message || "The drawing editor could not be opened.");
  }

  render() {
    if (this.state.failed) {
      return <div role="alert" style={{ padding: 24 }}>The drawing editor could not be opened. Reopen this board to try again.</div>;
    }
    return this.props.children;
  }
}

/**
 * A snapshot seeds one mounted document. With isCollaborating, remote snapshots
 * update scene data without changing the participant's viewport or selection.
 * apiRef.current exposes Excalidraw's native imperative API while mounted.
 */
export default function DiagramSketch({ snapshot, onChange, theme = "dark", onError, apiRef, readOnly = false, isCollaborating = false, onUndo, onRedo, canUndo, canRedo, onPointerUpdate, presence = [] }) {
  const callbacks = useRef({ onChange, onError, apiRef });
  callbacks.current = { onChange, onError, apiRef, readOnly, isCollaborating, onUndo, onRedo, onPointerUpdate };
  const nativeApi = useRef(null);
  const mounted = useRef(true);
  const fileInput = useRef(null);
  const replayedDrops = useRef(new WeakSet());
  const initialData = useRef(null);
  const latest = useRef(null);
  const previous = useRef(null);
  const sceneInitialized = useRef(false);
  const libraryInitialized = useRef(false);
  const lastReportedError = useRef(null);
  const initialError = useRef(null);
  const applyingRemote = useRef(false);

  if (!initialData.current) {
    let seed;
    try {
      seed = sanitizeSketchSnapshot(snapshot);
    } catch (error) {
      initialError.current = error.message;
      seed = sanitizeSketchSnapshot();
    }
    initialData.current = structuredClone(seed);
    latest.current = structuredClone(seed);
  }

  const reportError = useCallback((message) => {
    callbacks.current.onError?.(message);
  }, []);

  const emitSnapshot = useCallback(() => {
    if (callbacks.current.readOnly || applyingRemote.current) return;
    try {
      // Excalidraw mutates elements internally. Detach the snapshot handed to
      // persistence so subsequent pointer events cannot mutate a queued save.
      const next = structuredClone(latest.current);
      const result = callbacks.current.onChange?.(next);
      if (result && typeof result.catch === "function") {
        result.catch((error) => reportError(error.message || "The drawing could not be saved."));
      }
    } catch (error) {
      reportError(error.message || "The drawing could not be saved.");
    }
  }, [reportError]);

  const handleChange = useCallback((elements, appState, files) => {
    if (appState.isLoading) return;
    // Native image insertion can occur without onPaste (for example its image
    // picker). Never persist unsupported payloads; remove their canvas elements.
    const safeFiles = {};
    const invalidFileIds = new Set();
    const referencedFileIds = new Set(elements.map(element => element.fileId).filter(Boolean));
    for (const [id, file] of Object.entries(files)) {
      const previousFile = latest.current.files[id];
      // Excalidraw retains unused files internally after updateScene. Do not
      // reintroduce a remotely removed file merely because its cache retains it.
      if (callbacks.current.isCollaborating && !previousFile && !referencedFileIds.has(id)) continue;
      try {
        // Validate newly supplied binary data once, not each pointer event.
        if (previousFile && previousFile.dataURL === file?.dataURL
            && previousFile.mimeType === file.mimeType && previousFile.id === file.id) {
          safeFiles[id] = { ...file };
        } else Object.assign(safeFiles, sanitizeSketchFiles({ [id]: file }));
      }
      catch (error) {
        invalidFileIds.add(id);
        if (lastReportedError.current !== error.message) {
          lastReportedError.current = error.message;
          reportError(error.message);
        }
      }
    }
    let safeElements;
    try { safeElements = localElements(elements).filter(element => !invalidFileIds.has(element.fileId)); }
    catch (error) { reportError(error.message); return; }
    if (safeElements.length !== elements.length || safeElements.some((element, index) => element !== elements[index])) {
      nativeApi.current?.updateScene({ elements: safeElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return;
    }
    files = safeFiles;
    if (appState.errorMessage !== lastReportedError.current) {
      lastReportedError.current = appState.errorMessage;
      if (appState.errorMessage) reportError(appState.errorMessage);
    }
    const saved = savedAppState(appState);
    const stamp = { elements: elementStamp(elements), appState: JSON.stringify(saved) };
    const changed = previous.current
      && (previous.current.elements !== stamp.elements
        || (!callbacks.current.isCollaborating && previous.current.appState !== stamp.appState)
        || !sameFiles(latest.current.files, files));
    // Copy file records cheaply for change detection without repeatedly hashing
    // large base64 images on pointer/selection updates.
    latest.current = {
      ...latest.current,
      elements,
      appState: saved,
      files: Object.fromEntries(Object.entries(files).map(([id, file]) => [id, { ...file }])),
    };
    previous.current = stamp;
    if (!sceneInitialized.current) {
      sceneInitialized.current = true;
      return;
    }
    if (changed) emitSnapshot();
  }, [emitSnapshot, reportError]);

  const handleLibraryChange = useCallback((libraryItems) => {
    const safeItems = libraryItems.flatMap(item => {
      try { return localLibrary([item]); }
      catch (error) { reportError(error.message); return []; }
    });
    const changed = libraryStamp(latest.current.libraryItems) !== libraryStamp(safeItems);
    latest.current.libraryItems = safeItems;
    if (libraryStamp(safeItems) !== libraryStamp(libraryItems)) {
      // Native library imports produce inert previews before this callback. Clean
      // the library immediately, before an item can be inserted into the canvas.
      nativeApi.current?.updateLibrary({ libraryItems: safeItems, merge: false }).catch((error) => {
        reportError(error.message || "The drawing library could not be imported.");
      });
      reportError("Embedded HTML widgets were omitted from the imported library.");
    }
    // initialData always contains libraryItems, so the first library callback
    // is Excalidraw's asynchronous restoration, not a user edit.
    if (!libraryInitialized.current) {
      libraryInitialized.current = true;
      return;
    }
    if (changed) emitSnapshot();
  }, [emitSnapshot, reportError]);

  const handleApi = useCallback((api) => {
    nativeApi.current = api;
    if (callbacks.current.apiRef) callbacks.current.apiRef.current = api;
  }, []);

  const handlePaste = useCallback((data) => {
    if (callbacks.current.readOnly) return false;
    try { assertLocalSketchData(data); }
    catch (error) { reportError(error.message); return false; }
    if (data.elements?.some((element) => element.type === "iframe" || element.type === "magicframe")) {
      reportError("This clipboard selection contains embedded HTML. Paste ordinary drawing elements instead.");
      return false;
    }
    return true;
  }, [reportError]);

  const handleLinkOpen = useCallback((element, event) => {
    if (!sanitizeSketchLink(element.link)) {
      event.preventDefault();
      reportError("Only web, email, telephone and in-drawing links can be opened.");
    }
  }, [reportError]);

  const importFile = useCallback(async (file, allowPlainImage = false) => {
    if (callbacks.current.readOnly) return true;
    const api = nativeApi.current;
    if (!api || !mounted.current) return true;
    try {
      const imported = await loadSceneOrLibraryFromBlob(file, api.getAppState(), api.getSceneElements());
      if (!mounted.current || nativeApi.current !== api) return true;
      if (imported.type === MIME_TYPES.excalidrawlib) {
        const items = await loadLibraryFromBlob(file);
        if (!mounted.current || nativeApi.current !== api) return true;
        const safeItems = localLibrary(items);
        await api.updateLibrary({ libraryItems: safeItems, merge: true, openLibraryMenu: true });
        if (libraryStamp(items) !== libraryStamp(safeItems)) {
          reportError("Embedded HTML widgets were omitted from the imported library.");
        }
      } else {
        const validated = sanitizeSketchSnapshot(imported.data);
        const filtered = validated.elements;
        const elements = restoreElements(filtered, null, { repairBindings: true, refreshDimensions: false });
        api.addFiles(Object.values(validated.files));
        api.updateScene({
          elements,
          appState: {
            ...validated.appState,
            fileHandle: null,
            activeTool: { type: "selection", customType: null, lastActiveTool: null, locked: false },
            selectedElementIds: {},
            selectedGroupIds: {},
          },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.scrollToContent(elements);
        if (filtered.length !== imported.data.elements.length) {
          reportError("Embedded HTML widgets were omitted from the imported drawing.");
        }
      }
    } catch (error) {
      // Only an image positively identified by Excalidraw as having no scene
      // metadata may continue to the native image-insertion path.
      if (allowPlainImage && error.code === "IMAGE_NOT_CONTAINS_SCENE_DATA") {
        if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name || "")) {
          reportError("SVG image insertion is not supported. Export it to PNG before inserting it.");
          return true;
        }
        return false;
      }
      reportError(error.message || "This file could not be opened as a drawing.");
    }
    return true;
  }, [reportError]);

  const openFile = useCallback(() => { if (!callbacks.current.readOnly) fileInput.current?.click(); }, []);

  const handleFileChange = useCallback(async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) await importFile(file);
  }, [importFile]);

  const handleKeyDown = useCallback((event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.isComposing
        && callbacks.current.onUndo && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation();
      if (!callbacks.current.readOnly) {
        if (event.shiftKey || event.key.toLowerCase() === 'y') callbacks.current.onRedo?.();
        else callbacks.current.onUndo();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        && event.key.toLowerCase() === "o" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      openFile();
    }
  }, [openFile]);

  const handleDrop = useCallback(async (event) => {
    if (callbacks.current.readOnly) { event.preventDefault(); event.stopPropagation(); return; }
    if (replayedDrops.current.has(event.nativeEvent)) return;
    const file = event.dataTransfer.files?.[0];
    const libraryData = event.dataTransfer.getData(MIME_TYPES.excalidrawlib);
    if (!file && !libraryData) return;
    if (!file && libraryData) {
      try {
        // Preserve native placement when dragging ordinary library items.
        const parsed = JSON.parse(libraryData);
        assertLocalSketchData(parsed);
        if (!containsHtmlWidget(parsed)) return;
        reportError("This library selection contains embedded HTML and cannot be inserted.");
      } catch (error) {
        reportError(error.message || "This library selection is not a valid drawing library.");
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.target;
    const { clientX, clientY } = event;
    const handled = await importFile(file, true);
    if (!handled && mounted.current && nativeApi.current && target.isConnected) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const replay = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY });
      replayedDrops.current.add(replay);
      target.dispatchEvent(replay);
    }
  }, [importFile, reportError]);

  useEffect(() => {
    if (!isCollaborating || !nativeApi.current) return;
    try {
      const api = nativeApi.current;
      const current = latest.current;
      // Libraries are personal and omitted from the shared document. Receiving
      // a board update must not clear a library imported in this browser.
      const incoming = { ...sanitizeSketchSnapshot(snapshot), libraryItems: current.libraryItems };
      if (elementStamp(incoming.elements) === elementStamp(current.elements)
          && sameFiles(current.files, incoming.files)
          && libraryStamp(current.libraryItems) === libraryStamp(incoming.libraryItems)) return;
      const elements = restoreElements(incoming.elements, null, { repairBindings: true, refreshDimensions: false });
      const appState = savedAppState(api.getAppState());
      const libraryChanged = libraryStamp(current.libraryItems) !== libraryStamp(incoming.libraryItems);
      applyingRemote.current = true;
      latest.current = { ...incoming, elements, appState };
      previous.current = { elements: elementStamp(elements), appState: JSON.stringify(appState) };
      api.addFiles(Object.values(incoming.files));
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      if (libraryChanged) void api.updateLibrary({ libraryItems: incoming.libraryItems, merge: false }).catch(error => reportError(error.message));
      // Collaboration history tracks this user's transactions across both views.
      // Native history must never be able to undo somebody else's snapshot.
      api.history?.clear();
    } catch (error) { reportError(error.message || 'The shared drawing could not be updated.'); }
    finally { applyingRemote.current = false; }
  }, [snapshot, isCollaborating, reportError]);

  useEffect(() => {
    if (!isCollaborating || !nativeApi.current) return;
    const collaborators = new Map(presence.filter(peer => peer.mode === 'sketch' && peer.cursor).map(peer => [String(peer.clientId), {
      username: peer.name || 'Guest', pointer: { ...peer.cursor, tool: 'pointer' },
      color: { background: peer.color || '#78a9ff', stroke: peer.color || '#78a9ff' },
    }]));
    nativeApi.current.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }, [presence, isCollaborating]);

  useEffect(() => {
    if (apiRef) apiRef.current = nativeApi.current;
    return () => {
      if (apiRef?.current === nativeApi.current) apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    mounted.current = true;
    if (initialError.current) {
      reportError(initialError.current);
      initialError.current = null;
    }
    return () => { mounted.current = false; };
  }, [reportError]);

  return (
    <div data-argus-diagram-sketch="true" data-shared-history={Boolean(onUndo)} onKeyDownCapture={handleKeyDown} onDropCapture={handleDrop} style={{ width: "100%", height: "100%", minHeight: 320, position: "relative" }}>
      <input ref={fileInput} type="file" accept=".excalidraw,.json,.excalidrawlib,.png,.svg" aria-label="Open local drawing" style={{ display: "none" }} onChange={handleFileChange} />
      {/* These pinned 0.18.1 controls have no public visibility prop. Keep local
          library import/export and keyboard help while omitting web publishing. */}
      <style>{`
        [data-argus-diagram-sketch] .library-menu-browse-button,
        [data-argus-diagram-sketch] [data-testid="lib-dropdown--remove"],
        [data-argus-diagram-sketch] .HelpDialog__header {
          display: none !important;
        }
        [data-shared-history="true"] .undo-redo-buttons { display: none !important; }
      `}</style>
      {onUndo && <div style={{position:'absolute',bottom:16,left:170,zIndex:5,display:'flex',gap:4}} aria-label="Shared drawing history"><button disabled={readOnly || !canUndo} onClick={onUndo} aria-label="Undo last personal change">Undo</button><button disabled={readOnly || !canRedo} onClick={onRedo} aria-label="Redo last personal change">Redo</button></div>}
      <SketchErrorBoundary onError={reportError}>
        <Excalidraw
          initialData={initialData.current}
          excalidrawAPI={handleApi}
          onChange={handleChange}
          onLibraryChange={handleLibraryChange}
          onPaste={handlePaste}
          onLinkOpen={handleLinkOpen}
          onPointerUpdate={payload => callbacks.current.onPointerUpdate?.({ mode: 'sketch', cursor: payload.pointer })}
          theme={theme === "light" ? "light" : "dark"}
          UIOptions={UI_OPTIONS}
          isCollaborating={isCollaborating}
          viewModeEnabled={readOnly}
          aiEnabled={false}
          validateEmbeddable={false}
          renderEmbeddable={NO_EMBED}
          handleKeyboardGlobally={false}
        >
          <MainMenu>
            {!readOnly && <MainMenu.Item onSelect={openFile} shortcut="Ctrl/Cmd+O" aria-label="Open local drawing">Open drawing…</MainMenu.Item>}
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.CommandPalette />
            <MainMenu.DefaultItems.Help />
            {!readOnly && <MainMenu.DefaultItems.ClearCanvas />}
            <MainMenu.Separator />
            {!readOnly && <MainMenu.DefaultItems.ChangeCanvasBackground />}
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Hints.ToolbarHint />
            <WelcomeScreen.Hints.MenuHint />
            <WelcomeScreen.Hints.HelpHint />
          </WelcomeScreen>
        </Excalidraw>
      </SketchErrorBoundary>
    </div>
  );
}
