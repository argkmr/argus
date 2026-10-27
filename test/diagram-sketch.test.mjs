import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as sketchModel from "../frontend/features/diagrams/diagram-sketch-model.mjs";
import { emptySnapshot, parseBoardImport } from "../frontend/features/diagrams/diagram-model.mjs";

const source = fs.readFileSync(new URL("../frontend/features/diagrams/DiagramSketch.jsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics.length, 0, "The drawing wrapper must transpile");

const TYPES = { excalidraw: "application/vnd.excalidraw+json", excalidrawlib: "application/vnd.excalidrawlib+json" };
const clean = (value) => JSON.parse(JSON.stringify(value));
const shape = (extra = {}) => ({ id: "shape", type: "rectangle", version: 1, versionNonce: 7, x: 1, ...extra });
const image = { id: "image", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII=", created: 1 };
const view = { scrollX: 1, scrollY: 2, zoom: { value: 1 } };

function harness(snapshot = {}, overrides = {}) {
  const refs = [], cleanups = [], saved = [], errors = [], calls = [];
  let index = 0, tree, editor;
  const jsx = (type, props) => ({ type, props });
  const Excalidraw = () => {};
  const MainMenu = Object.assign(() => {}, {
    Item: "menuItem", Separator: "separator",
    DefaultItems: new Proxy({}, { get: (_, key) => key }),
  });
  const WelcomeScreen = Object.assign(() => {}, {
    Hints: { ToolbarHint: "toolbarHint", MenuHint: "menuHint", HelpHint: "helpHint" },
  });
  class DataTransfer {
    files = [];
    items = { add: (file) => this.files.push(file) };
    getData() { return ""; }
  }
  class DragEvent {
    constructor(type, options) { Object.assign(this, { type, ...options }); }
  }
  const imports = {
    react: {
      Component: class {}, useCallback: (fn) => fn,
      useEffect: (effect) => cleanups.push(effect()),
      useRef: (value) => refs[index++] ||= { current: value },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "@excalidraw/excalidraw/index.css": {},
    "./diagram-sketch-model.mjs": sketchModel,
    "@excalidraw/excalidraw": {
      Excalidraw, MainMenu, WelcomeScreen, MIME_TYPES: TYPES,
      CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
      loadSceneOrLibraryFromBlob: async (file) => {
        calls.push(["parse", file]);
        if (file.error) throw file.error;
        return file.parsed;
      },
      loadLibraryFromBlob: async (file) => file.parsed.data.libraryItems,
      restoreElements: (elements, previous, options) => {
        calls.push(["repair", options]);
        return elements;
      },
    },
  };
  const context = vm.createContext({
    exports: {}, window: {}, structuredClone, DataTransfer, DragEvent,
    require: (name) => {
      assert.ok(name in imports, `Unexpected module ${name}`);
      return imports[name];
    },
  });
  vm.runInContext(compiled.outputText, context);
  function find(node, type) {
    if (node?.type === type) return node;
    return [].concat(node?.props?.children || []).map((child) => find(child, type)).find(Boolean);
  }
  const apiRef = { current: null };
  function render(nextSnapshot = snapshot) {
    index = 0;
    tree = context.exports.default({
      snapshot: nextSnapshot, theme: "dark", apiRef,
      onChange: (next) => saved.push(next), onError: (message) => errors.push(message),
    });
    editor = find(tree, Excalidraw).props;
    return editor;
  }
  const api = {
    getAppState: () => view,
    getSceneElements: () => snapshot.elements || [],
    addFiles: (files) => calls.push(["files", files]),
    updateScene: (scene) => calls.push(["scene", scene]),
    scrollToContent: (elements) => calls.push(["scroll", elements]),
    updateLibrary: async (options) => {
      calls.push(["library", options]);
      editor.onLibraryChange(options.libraryItems);
    },
    ...overrides,
  };
  render();
  editor.excalidrawAPI(api);
  const initialize = () => {
    editor.onLibraryChange(editor.initialData.libraryItems);
    editor.onChange(editor.initialData.elements, view, editor.initialData.files);
  };
  return {
    saved, errors, calls, apiRef, api, render, initialize,
    get editor() { return editor; }, get tree() { return tree; },
    input: () => find(tree, "input"),
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

test("opening and selecting a sketch never creates an autosave loop, while real edits save detached image data", () => {
  const h = harness({ elements: [shape()], files: { image } });
  h.initialize();
  const initialData = h.editor.initialData;
  const elements = initialData.elements;
  h.editor.onChange(elements, { ...view, selectedElementIds: { shape: true }, collaborators: new Map() }, { image });
  assert.equal(h.saved.length, 0);
  elements[0].version = 2;
  elements[0].x = 42;
  h.editor.onChange(elements, { ...view, editingTextElement: { temporary: true } }, { image });
  assert.equal(h.saved.length, 1);
  elements[0].x = 999;
  assert.equal(h.saved[0].elements[0].x, 42);
  assert.equal(h.saved[0].files.image.dataURL, image.dataURL);
  assert.deepEqual(clean(h.saved[0].appState), view);
  h.render(h.saved[0]);
  assert.equal(h.editor.initialData, initialData, "autosave echoes must not reset undo history");
});

test("image changes and library-only edits persist; clipboard HTML widgets are rejected", () => {
  const h = harness({ elements: [shape()], files: { image } });
  h.initialize();
  h.editor.onChange([shape()], view, { image: { ...image, version: 2 } });
  assert.equal(h.saved.length, 1);
  h.editor.onLibraryChange([{ id: "local", status: "unpublished", created: 1, elements: [shape()] }]);
  assert.equal(h.saved.length, 2);
  assert.equal(h.saved[1].libraryItems.length, 1);
  h.editor.onLibraryChange([]);
  assert.equal(h.saved.length, 3);
  assert.equal(h.editor.onPaste({ elements: [shape({ type: "iframe" })] }), false);
  assert.equal(h.editor.onPaste({ elements: [shape()] }), true);
});

test("initial and native-imported libraries omit HTML widgets before insertion or persistence", async () => {
  const unsafe = shape({ id: "html", type: "iframe", customData: { generationData: { html: "<script>bad()</script>" } } });
  const h = harness({
    elements: [shape(), unsafe, shape({ id: "magic", type: "magicframe" })],
    libraryItems: [{ id: "lib", elements: [shape(), unsafe] }],
  });
  assert.equal(h.editor.initialData.elements.length, 1);
  assert.equal(h.editor.initialData.libraryItems[0].elements.length, 1);
  h.initialize();
  h.editor.onLibraryChange([{ id: "other", elements: [unsafe, shape()] }]);
  await Promise.resolve();
  const update = h.calls.find(([name]) => name === "library")[1];
  assert.equal(update.libraryItems[0].elements.length, 1);
  assert.equal(update.merge, false);
  assert.ok(h.saved.every((item) => item.libraryItems.every((library) => library.elements.every((element) => element.type !== "iframe"))));
});

test("Open drawing validates embedded scenes, repairs bindings, keeps images and supports native undo", async () => {
  const h = harness();
  h.initialize();
  const input = { files: [{ parsed: {
    type: TYPES.excalidraw,
    data: {
      elements: [shape(), shape({ id: "html", type: "iframe" })],
      appState: { ...view, fileHandle: { unsafe: true } }, files: { image },
    },
  } }], value: "chosen" };
  await h.input().props.onChange({ currentTarget: input });
  assert.equal(input.value, "");
  const scene = h.calls.find(([name]) => name === "scene")[1];
  assert.equal(scene.elements.length, 1);
  assert.equal(scene.captureUpdate, "IMMEDIATELY");
  assert.equal(scene.appState.fileHandle, null);
  assert.equal(h.calls.find(([name]) => name === "files")[1][0].dataURL, image.dataURL);
  assert.equal(h.calls.find(([name]) => name === "repair")[1].repairBindings, true);
  assert.equal(h.editor.UIOptions.canvasActions.loadScene, false);
  assert.equal(h.editor.UIOptions.canvasActions.export.saveFileToDisk, true);
  assert.ok(h.errors.some((message) => message.includes("omitted")));
});

test("plain-image drops replay once through native insertion, while unsafe library drops are blocked", async () => {
  const h = harness();
  const error = Object.assign(new Error("No scene"), { code: "IMAGE_NOT_CONTAINS_SCENE_DATA" });
  let prevented = 0, dispatched = 0;
  const event = {
    nativeEvent: {}, clientX: 12, clientY: 22,
    dataTransfer: { files: [{ error }], getData: () => "" },
    preventDefault: () => prevented++, stopPropagation() {},
    target: { isConnected: true, dispatchEvent: (nativeEvent) => {
      dispatched++;
      h.tree.props.onDropCapture({ ...event, nativeEvent });
    } },
  };
  await h.tree.props.onDropCapture(event);
  assert.equal(dispatched, 1);
  assert.equal(h.calls.filter(([name]) => name === "parse").length, 1);
  assert.equal(prevented, 1);
  const safeLibrary = { ...event, nativeEvent: {}, dataTransfer: { files: [], getData: () => JSON.stringify({ libraryItems: [{ elements: [shape()] }] }) } };
  await h.tree.props.onDropCapture(safeLibrary);
  assert.equal(prevented, 1, "safe library drags must retain native placement");
  await h.tree.props.onDropCapture({ ...safeLibrary, dataTransfer: { files: [], getData: () => JSON.stringify({ libraryItems: [{ elements: [shape({ type: "iframe" })] }] }) } });
  assert.equal(prevented, 2);
  assert.ok(h.errors.some((message) => message.includes("cannot be inserted")));
});

test("Open shortcut uses the validated picker; unmount clears the imperative API", () => {
  const h = harness();
  let clicked = 0, prevented = 0;
  h.input().props.ref.current = { click: () => clicked++ };
  h.tree.props.onKeyDownCapture({ metaKey: true, key: "o", preventDefault: () => prevented++, stopPropagation() {} });
  assert.equal(clicked, 1);
  assert.equal(prevented, 1);
  assert.equal(h.apiRef.current, h.api);
  h.unmount();
  assert.equal(h.apiRef.current, null);
});

test("shared validation rejects remote URLs, SVG and unknown image MIME types before board persistence", () => {
  for (const dataURL of ['https://example.invalid/image.png', 'file:///private/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz4=', 'data:text/html;base64,dGVzdA==']) {
    const files = { image: { ...image, dataURL } };
    assert.throws(() => sketchModel.sanitizeSketchSnapshot({ files }), /raster/);
    assert.throws(() => parseBoardImport(JSON.stringify({ type: 'excalidraw', elements: [], files })), /raster/);
    assert.throws(() => parseBoardImport(JSON.stringify({ format: 'argus-diagram', schemaVersion: 1, snapshot: { ...emptySnapshot(), sketch: { ...emptySnapshot().sketch, files } } })), /raster/);
  }
  assert.throws(() => sketchModel.sanitizeSketchSnapshot({ files: { image: { ...image, mimeType: 'image/svg+xml' } } }), /raster/);
  const imported = parseBoardImport(JSON.stringify({ type: 'excalidraw', elements: [shape(), shape({ type: 'iframe' })], appState: { ...view, fileHandle: { name: 'not persisted' } }, files: { image } }));
  assert.equal(imported.snapshot.sketch.elements.length, 1);
  assert.equal(imported.snapshot.sketch.appState.fileHandle, undefined);
  assert.equal(imported.snapshot.sketch.files.image.dataURL, image.dataURL);
});

test("native Open, clipboard and library boundaries reject remote binary data", async () => {
  const badImage = { ...image, dataURL: 'https://example.invalid/track.png' };
  const h = harness();
  h.initialize();
  assert.equal(h.editor.onPaste({ elements: [], files: { image: badImage } }), false);
  await h.input().props.onChange({ currentTarget: { files: [{ parsed: { type: TYPES.excalidraw, data: { elements: [], files: { image: badImage } } } }], value: '' } });
  assert.equal(h.calls.some(([name]) => name === 'scene' || name === 'files'), false);
  const unsafeLibrary = [{ id: 'remote', elements: [shape({ customData: { image: badImage } })] }];
  h.editor.onLibraryChange(unsafeLibrary);
  assert.equal(h.calls.find(([name]) => name === 'library')[1].libraryItems.length, 0);
  let prevented = false;
  await h.tree.props.onDropCapture({ nativeEvent: {}, dataTransfer: { files: [], getData: () => JSON.stringify(unsafeLibrary) }, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  const initial = harness({ files: { image: badImage } });
  assert.deepEqual(clean(initial.editor.initialData.files), {});
  assert.ok(initial.errors.some(message => message.includes('raster')));
});

test("unsupported native image payloads cannot enter saved snapshots", () => {
  const h = harness();
  h.initialize();
  const badImage = { ...image, dataURL: 'data:image/svg+xml;base64,PHN2Zz4=', mimeType: 'image/svg+xml' };
  h.editor.onChange([shape({ type: 'image', fileId: 'image' })], view, { image: badImage });
  const scene = h.calls.find(([name]) => name === 'scene')[1];
  assert.deepEqual(clean(scene.elements), []);
  assert.equal(h.saved.length, 0);
});

test("unsafe hyperlink schemes are stripped from imported scenes and libraries and blocked on click", () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,test', 'file:///private/test', 'vbscript:bad()', 'java\nscript:alert(1)', 'about:blank', '//example.invalid']) {
    const imported = parseBoardImport(JSON.stringify({ type: 'excalidraw', elements: [shape({ link })] }));
    assert.equal(imported.snapshot.sketch.elements[0].link, null);
    assert.equal(sketchModel.sanitizeSketchLibrary([{ elements: [shape({ link })] }])[0].elements[0].link, null);
    const h = harness();
    let prevented = false;
    h.editor.onLinkOpen({ link }, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  }
  for (const link of ['https://example.com', 'http://localhost:8080', 'mailto:hello@example.com', 'tel:+12345', '#element=shape']) {
    assert.equal(sketchModel.sanitizeSketchElements([shape({ link })])[0].link, link);
  }
});
