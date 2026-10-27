# Eraser icon catalog and source attribution

Argus indexes the names and categories published at <https://docs.eraser.io/icons>.
The snapshot checked on 2026-10-22 contains 3,951 names across AWS (440), Google
Cloud (250), Azure (703), Oracle Cloud (26), Kubernetes (40), Networking (81),
Tech logos (664), and General icons (1,747). The screenshot's “250+” description
is not the current catalog size. The reproducible metadata-only update command
is `node scripts/sync-eraser-icon-catalog.mjs --patch`; inspect and apply its
patch. A digest and source URL are included in the generated module. This
command does not download the artwork.

## Source code versus hosted artwork

Eraser's open-source renderer is MIT-licensed. The hosted vendor icon artwork
does not come with a blanket redistribution license in that repository. Argus
does not claim that the MIT license covers those brand assets and does not
bulk-vendor or re-host their catalog. Logos remain the property of their
respective owners and their trademark and asset terms continue to apply.

Argus uses the on-demand icon-loading approach documented by Eraser:
<https://github.com/eraserlabs/eraser-diagrams/blob/main/GETTING_STARTED.md#icons>
and
<https://github.com/eraserlabs/eraser-diagrams/blob/main/packages/diagrams/src/icons/eraserLoader.ts>.
Only the icon name is sent to Eraser's public asset host, never board contents,
notes, credentials, or session tokens. Our application proxy is necessary because
the public bucket does not currently send browser CORS headers. It is not an
arbitrary URL proxy. The documented legacy name `eraser.io` resolves to the
existing `eraser-io` artwork; the dot spelling currently returns HTTP 404.

The browser keeps an opportunistic IndexedDB cache of recently used artwork,
limited to 256 entries and 8 MiB. Runtime memory caches have the same bounds.
Cached recent icons work offline; an icon not previously cached still requires
network access. This is not a bundled offline copy of every icon. The upstream
service may change or withdraw icons. Error states must remain visible and an
export requiring an unavailable icon must fail rather than silently omit it.

## SVG security and provenance

The following files are mechanically transpiled ESM copies of current Eraser
source at commit `1f5eefd53fa42010dd86321e600d68fdce37b30d`, licensed under the
adjacent `eraser-diagrams.LICENSE`:

- `frontend/features/diagrams/eraser-static-svg.mjs` —
  `packages/resolve/src/icons/svg-sanitize.ts`.
- `frontend/features/diagrams/eraser-svg-transforms.mjs` —
  `packages/templates/src/svgTransforms.ts`; its validator import points to the
  first local module.

These current source files are used instead of the published 0.2.0 package's
weaker regex-only normalizer. The dependency on `parse5` preserves the upstream
static-SVG element, attribute, namespace, CSS-value, nesting, and external-URL
checks. They load lazily on the first icon request. Argus removes only Cisco's
redundant standard `xmlns:svg` declaration before validation; the validator
itself is unchanged. Class-based brand colors are normalized and preserved.
Monochrome symbols receive theme ink. SVGs are displayed only as image data
URIs, not injected as executable HTML.

The upstream 64 KiB SVG safety limit remains in force. Larger or unsupported
SVGs are rejected with an icon-load error, rather than weakening validation.
Requests have timeouts, response-size bounds, concurrency limits, bounded
caches, same-name deduplication, and failure backoff. The catalog itself is an
allowlist; names are encoded as one URL path segment. The Java service uses a
generated matching name resource.

## Scope of the open-source templates

The MIT shape library includes rectangle, parallelogram, trapezoid, diamond,
cylinder, hexagon, circle, ellipse, oval, triangle, document, and star. Its
standalone icon visual has the caption below the symbol, not inside a card.
The Eraser GUI, AI prompts, and Device Frame editor are not included in the
open-source renderer. Argus's editor and notes controls are independent
implementations; including Eraser assets does not imply GUI feature parity or
endorsement by Eraser.
