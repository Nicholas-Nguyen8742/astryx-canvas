# TRD Deviations

Where the implementation deliberately departs from the *Astryx Architecture Canvas*
Technical Requirements Document (v0.1, 2026-10-17), and why.

**Read this before "fixing" the code to match the TRD.** Several TRD recommendations
were written against APIs that do not exist, or against library versions that have
since changed. In each case below the TRD is the stale artifact, not the code.

Verified against the npm registry and `facebook/astryx` on 2026-10-16, with
Astryx `0.7.1`, StyleX `0.19.1`, Electron `44.8.0`, Vite `7.3.7`.

---

## 1. `@astryx/tokens` does not exist (TRD §11.1)

**TRD says:** consume tokens via `import { astryxTokens } from "@astryx/tokens"` and
index them as a JS object (`astryxTokens.color.surface.default`).

**Reality:** that package 404s on npm. There is no JS token object API.

**Actual surface:** `@astryxdesign/core/theme/tokens`, consumed as CSS custom
properties — `var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`. Themes are
CSS-variable overrides applied by the `<Theme>` provider.

**Consequence for document data:** `.astrx` colours are stored as
`{token?: string; hex: string}` (§12.3 rule 3). The live canvas paints
`var(--token)` so objects follow theme and dark-mode changes for free; export
resolves to the concrete hex, because a standalone SVG has left the app's
stylesheet behind. Both halves are required — see `resolveColor()` in
`src/renderer/src/editor/canvas/shape-attrs.ts`.

Verified token names in use: `--color-background-surface`, `--color-background-body`,
`--color-accent`, `--color-accent-muted`, `--color-text-primary`,
`--color-text-secondary`, `--color-text-red`, `--color-border-emphasized`,
`--radius-container`, `--spacing-0-5`, `--spacing-4`. There is **no** `--radius-lg`
and **no** `--border-width-*`; the radius scale is
`none|inner|element|container|page|full`.

---

## 2. `@stylexjs/vite-plugin` does not exist (TRD §9)

**TRD says:** build tooling is "Vite + electron-vite", with StyleX implied.

**Reality:** no `@stylexjs/vite-plugin` is published. The Vite/Rollup plugin is
`@stylexjs/rollup-plugin`.

**More importantly:** Astryx ships **prebuilt**, so consuming it needs no StyleX
compiler at all. The project uses the plain-CSS path, which the generated
`AGENTS.md` states outright: *"No StyleX/Tailwind compiler here."*

A compiler would only be needed to author our own `stylex.create()` styles or to
swizzle a component. `@stylexjs/rollup-plugin` was installed and then removed: it
emits its stylesheet from Rollup **bundle** hooks via `this.emitFile`, and Vite dev
has no bundle, so styles would be missing entirely in development.

---

## 3. Fabric.js rejected; the canvas is a custom SVG renderer (TRD §9.1)

**TRD says:** "Recommended primary engine: Fabric.js" (v6), with Konva as the
alternative.

**Reality, verified on npm:**

| | Fabric 7.4.0 | Konva 10.9.0 |
|---|---|---|
| Hard runtime deps | `canvas ^3.2.0`, `jsdom ^26.1.0` | `canvas ^3.0.0`, `skia-canvas ^3.0.0` |
| Unpacked size | 22.2 MB | 1.9 MB |
| Last published | 2026-05-18 | 2026-10-15 |
| SVG export | `toSVG()` built in | **none** |

`canvas` and `skia-canvas` are node-gyp **native** modules. They exist only for
Node-side server rendering, yet would have to be installed, rebuilt against
Electron's ABI, and packaged for Windows + macOS + Linux + arm64 (NFR-PORT-01…04).
Konva additionally has no SVG export, while FR-EXP-02/11/12 make standalone SVG a
MUST and it is the hardest requirement to retrofit.

The TRD's "Fabric.js v6" target is also two majors stale.

**Decision:** custom SVG renderer. The whole engine added **+48 kB** to the
renderer bundle, against 22 MB unpacked for Fabric alone.

Two consequences to respect:

- **Export is serialisation, not conversion.** `shapeGeometry()` and
  `lineEndpoints()` in `shape-attrs.ts` are shared by the live canvas, the drag
  preview and the export writer. Adding a fourth call site that derives geometry
  itself is how a shape comes to render one way on screen and another in the file.
- **Hit testing is the browser's.** TRD §14.2's list — including stroke-only
  objects — is largely free via SVG pointer events, rather than hand-rolled.

---

## 4. `CanvasEngineAdapter` omits four methods from TRD §9.1

**TRD says:** the adapter exposes `mount`, `destroy`, `addObject`, `removeObject`,
`updateObject`, `getSelection`, `setSelection`, `render`, plus the export methods.

**Implemented:** `getContentBounds`, `exportSvg`, `exportRaster`.

**Why:** §9.1's shape assumes an imperative scene graph that a host must push
objects into. With declarative React, the Zustand document store *is* the scene
graph — rendering is a pure function of store state, and selection lives in the
editor store. Those four methods would be no-ops, and a fake abstraction misleads
the next reader more than an honest narrow one.

NFR-MAINT-05's actual requirement — that the engine be swappable behind an
interface — is still met for everything that would genuinely change between
engines: measurement and export. Rationale is in the header comment of
`src/renderer/src/editor/canvas/adapter.ts`.

---

## 5. jsPDF + svg2pdf.js are not needed for vector PDF (TRD §9, §15.4)

**TRD says:** PDF export uses "jsPDF + svg2pdf.js, with Electron `printToPDF`
fallback", vector-first.

**Implemented:** Chromium `printToPDF` as the *primary* path
(`src/main/pdf.ts`).

**Why:** this is not a fallback. Chromium draws the SVG into the PDF as paths, so
the output is vector and text stays text — which is the property the TRD wanted
from svg2pdf. Adding two libraries to re-implement what the renderer already does
would grow the dependency surface for no fidelity gain.

Printed through a throwaway hidden `BrowserWindow`, never the app's own
`webContents`, because printing the main window would capture the toolbar, rails
and status bar instead of the diagram. JavaScript is disabled on that window and
its temp directory is removed in a `finally`.

---

## 6. Vite 7 + plugin-react 5.2, not the latest (TRD §9)

**Constraint discovered:** `@vitejs/plugin-react@6` has an optional peer on
`@rolldown/plugin-babel`, whose chain pulls `@babel/core@^8`. That conflicts with
`@astryxdesign/cli`'s **exact** pin of `@babel/core@7.29.7`, and npm refuses the
resolution.

`@vitejs/plugin-react@5.2.0` peers only on `vite` (`^4 || ^5 || ^6 || ^7 || ^8`)
with no Babel 8 chain, so it satisfies everything. Vite 7 is used because it is
mature and inside every relevant peer range. Do not bump to Vite 8 + plugin-react 6
without first resolving the Astryx CLI's Babel pin.

---

## 7. TypeScript is pinned to 5.9, not latest

`npm install -D typescript` resolves to `7.0.2` (the native Go port). Pinned to
`~5.9.3` because the surrounding ecosystem — electron-vite, vitest, the Astryx
toolchain — peers on 5.x. NFR-MAINT-01's strict-mode requirement is unaffected.

---

## 8. Theme font stylesheets are redirected, not imported (TRD §11.6, NFR-OFF-02)

**Problem:** every first-party `@astryxdesign/theme-*` package ships a `fonts.css`
that is a single `@import url('https://fonts.googleapis.com/...')`. Neutral pulls
Figtree; the other six pull their own faces. `astryx theme add` writes that import
into the generated root-level `astryx-themes.js`.

That contradicts NFR-OFF-01/02/05, §11.6 ("no CDN references"), and the CSP in
§18.2 (`font-src 'self' data:`, `connect-src 'none'`). Left alone it is either
blocked — or, if the CSP were loosened, it leaks user IP and timing to Google
against NFR-SEC-09.

**Fix:** `electron.vite.config.ts` aliases `@astryxdesign/theme-neutral/fonts.css`
to `src/renderer/src/styles/astryx-fonts.css`, which is intentionally empty.

`astryx-themes.js` is **not** edited: the docs forbid hand-editing it and
`astryx doctor` verifies the module "exactly matches its record". Aliasing keeps
the generated file byte-identical while removing the network call.

Typography degrades cleanly with no `:root` override, because the theme already
declares a full fallback stack: `Figtree, -apple-system, BlinkMacSystemFont,
"Segoe UI", Roboto, Helvetica, Arial, sans-serif`.

**Outstanding:** NFR-OFF-02 is only partly met. No network call happens, but the
intended face is not bundled. To finish it, vendor the OFL-licensed Figtree woff2
files under `resources/fonts/` and add `@font-face` rules to that local sheet;
local files satisfy `font-src 'self'`.

---

## 9. The `canvas-editor` page template was rejected

`astryx build` recommends `canvas-editor` as the closest template. It is 2,876
lines of **9:16 social-poster** editor: a fixed `1080 x 1920` artboard scaled with
CSS `scale()`, text/image layers only, an HSV picker and nine image filters. That
is the opposite of an infinite world-coordinate canvas with ports, connectors and
architecture stencils.

Its *chrome* (document tabs, layer rail, inspector, zoom control) maps well onto
§11.4 and remains a useful reference, but adopting it would mean discarding its
central abstraction. Regenerate it any time with
`npx astryx template canvas-editor --type page <path>`.

Adopting it would also require solving §2 above, since the template uses StyleX.

---

## 10. Project layout follows electron-vite, not TRD §24

**TRD says:** `electron/main`, `electron/preload`, `electron/shared` alongside
`src/`.

**Implemented:** electron-vite's native `src/main`, `src/preload`, `src/renderer`,
with §24's module organisation preserved *inside* the renderer
(`editor/`, `document/`, `export/`, `state/`, `components/`, `design-system/`).

Deviation is in the top-level directory names only. Using the tool's own convention
keeps `electron.vite.config.ts` close to default and avoids custom
`build.rollupOptions.input` plumbing for every process.

`src/shared/` holds the IPC contract, which both main and preload import — the same
role §24 assigns to `electron/shared/`.

---

## 11. Electron Builder is kept current despite advisories

`npm audit` reports 8 moderate advisories in one transitive chain:
`sprintf-js` → `roarr` → `global-agent` → `@electron/get` → `app-builder-lib` →
`electron-builder`.

All of it is **dev-only**, runs solely at packaging time, and never ships or
executes in the app. The offered `npm audit fix --force` downgrades
`electron-builder` `26.15.3` → `26.5.0`, which likely predates Electron 44 support.

Deliberately not applied. NFR-SEC-11's intent (locked, audited dependencies) is met
by the lockfile plus this recorded, scoped assessment.

---

## 12. `polyline` is still deferred (FR-OBJ-01)

FR-OBJ-01 lists `polyline` as a MUST object type. It is **not yet implemented**,
while the other MUST shapes (`rectangle`, `roundedRectangle`, `ellipse`,
`circle`, `diamond`, `triangle`, `text`, `line`, `arrow`) are.

**This entry originally deferred `polyline` to the connector milestone on the
grounds that the two share a multi-point interaction and should be built
together. Connectors have since been built, and that prediction was only partly
right.** A connector gesture has fixed arity: click a source, click a target,
done. A polyline needs N vertices, a deliberate termination (Enter, double-click
or Escape), and live feedback for the segment currently being placed. The only
machinery the two genuinely share is "click a shape to anchor an endpoint", and
that now exists.

The deferral therefore still stands, but on narrower grounds than originally
stated: `polyline` needs a variable-length interaction of its own. It is real
new work, not a reuse of the connector tool, and should not be built as a
variant of it.

`polyline` and `path` remain valid `ObjectType` values in the schema (§12.1) and
round-trip through save/load, so no format change is needed when they arrive.
Until then a hand-authored document containing one falls through to the rectangle
branch of `shapeGeometry`, which draws a bounding box rather than the vertices —
an acknowledged gap, not a silent corruption.

---

## 13. Connector coverage is partial

Connectors are implemented end to end for the core case, but not every
`FR-CONN` behaviour is present. Recorded so the gap is not mistaken for
completion.

**Working:** creating an edge between two objects with a two-click gesture;
straight, orthogonal and curved routing; all four arrowhead shapes at either
end; anchoring to a port, with the four cardinal ports derived for any shape
that stores none and snap targets shown while wiring; falling back to the
shape's perimeter when a click misses every port; fallback points for endpoints
whose object is gone; labels drawn on both the canvas and in export, and
editable inline by double-click; independent selection, shown by a draggable
handle on each end; **re-attaching either end by dragging it** onto another
shape or port, which cancels rather than detaching when dropped on empty
canvas; deleting a connector on its own; deleting a shape cascading to its
edges; undo/redo across all of it; and identical rendering on the live canvas
and in SVG, PNG, JPEG and PDF export.

**Not implemented:**

- **No waypoint editing.** An orthogonal route always turns once, at the
  midpoint of its dominant axis. There is no way to add a bend or drag the
  existing one, so a route that crosses a shape cannot be steered around it.
  Re-attaching an end is implemented; steering the middle of the path is not.
- **No connector styling UI.** Routing and arrowheads are reachable only through
  the document format, not the app. `DocumentSettings.connectorDefaults` is
  preserved on save but is not consulted when a connector is created, so a
  document that customises it has no effect on new edges.
- **Custom ports cannot be authored.** The four cardinal ports are derived, and
  a shape that stores its own ports will use them, but nothing in the UI adds,
  moves or removes one.
- **`PortInstance.occupiedBy` is never populated.** The field exists so hover
  feedback can be suppressed on an already-used port. It could be derived from
  the connector list at render time instead, which would be impossible to let
  drift out of sync; storing it has no consumer yet, so neither choice has been
  made.

---

## Still to fold back into the TRD

The document itself has not been revised. If it is updated, sections needing
correction are: §9 (stack table — StyleX plugin, Fabric, jsPDF, TypeScript),
§9.1 (canvas engine and adapter interface), §11.1 (token API), §11.6 (font
bundling), §15.4 (PDF strategy), §24 (project layout).

FR-OBJ-01 should also note that `polyline` needs a variable-length interaction
of its own. It was originally sequenced with the connector requirements on the
assumption that they shared a multi-point gesture; building connectors showed
they share less than expected (see deviation 12), so `polyline` should be
scheduled as its own item rather than as a connector variant.

The connector requirements should be reviewed against deviation 13, which lists
what is implemented and what is not — notably that ports exist in the format and
in resolution but have no UI, so nothing currently attaches to one.
