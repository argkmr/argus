# Editable Canvas arrows

Structured Canvas supports Elbow, Straight and Arc connectors. New non-sequence connections default to Elbow. Existing boards retain their legacy paths until a route is selected or reset; sequence participant messages keep their timeline geometry.

## Controls

- Choose the default under **Route** in the toolbar. Select an existing connection to change its route in the Relationship inspector.
- Drag a round handle to reshape a connection. Drag a **+** segment handle or double-click the line to insert a bend. Up to 64 authored bends are retained per arrow.
- Double-click a bend, or focus it and press Delete / Backspace, to remove that bend without deleting the arrow. Arrow keys move a focused bend; Shift increases the step.
- Drag the grip beside the connection caption to move the label independently. Click the caption to edit text.
- **Reset arrow route** clears authored bends and label displacement. Undo / Redo reverses route changes. Escape or pointer cancellation abandons an in-progress drag without saving it.
- Dragging a handle previews locally and commits once on release. Coordinates account for canvas pan and zoom; routing controls are disabled for read-only viewers and Expanded notes.

Routes are retained in saved boards, portable JSON, SVG/PNG output and board collaboration. Duplicated internal arrows and arrows within a moved group translate with their objects. Moving only one endpoint leaves authored bends at their chosen canvas coordinates; endpoints remain attached. Expanded notes uses its existing automatic reading-layout routes and does not overwrite compact routes.

## Verification

`node --test test/diagram-connection-routing.test.mjs test/diagram-selection-ui.test.mjs test/canvas-collab-model.test.mjs`

The isolated Electron fixture uses synthetic boards, native pointer input and blocked network traffic. It does not touch installed-app profiles or user diagrams.
