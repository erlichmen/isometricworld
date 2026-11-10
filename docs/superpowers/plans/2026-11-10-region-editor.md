# Region Editor Implementation Plan

> **For agentic workers:** Execute tasks in order in this chat; review each deliverable before integration.

**Goal:** Build a local geographic editor that safely shares place configuration with the existing pipeline and viewer.

**Architecture:** Extend the existing npm-workspaces monorepo with editor and shared. A loopback Astro development server hosts the editor and a Node.js API through Vite middleware; the public viewer remains independent. One validated JSON document supplies the existing pipeline exports and editor.

**Tech Stack:** TypeScript, Astro, Leaflet 1.9, Leaflet-Geoman Free, Node.js built-ins and node:test.

## Global Constraints

- Open data only; visible © OpenStreetMap contributors attribution.
- Preserve every existing identifier, coordinate, heading and credit.
- Never delete data/derived or data/web-state, stop the user's server, publish or deploy.
- Do not modify web files while a film render is active; this implementation needs no web source changes.
- Preserve unrelated changes in package-lock.json, pipeline/src/fetch.ts and pipeline/test/.
- Keep existing root commands working and bind the editor to loopback.

### Task 1: Shared definitions and workspace wiring

**Files:** shared/package.json, shared/tsconfig.json, shared/src/{index.ts,world.json,validate.ts}, shared/test/world.test.ts; pipeline/src/{places.ts,areas.ts}; root package.json, package-lock.json and .gitignore; editor/package.json, editor/tsconfig.json.

**Interfaces:** `World` contains `regions: Record<string, Region>`, `cities: Record<string, City>`, `areas: Record<string, Area>`, `defaultCity: string`. `validateWorld(value: unknown): asserts value is World`. Export existing Region/City/Area types and REGIONS/CITIES/AREAS/DEFAULT_CITY from shared. Pipeline keeps existing import paths via re-exports.

- [x] Capture current definitions exactly in JSON and add shared types.
- [x] Validate exact object shapes, nonempty strings and arrays, lowercase ASCII hyphenated identifiers, finite ranged coordinates and headings, bbox ordering, positive city width, region references, default city and the OSM/Copernicus/AI credit requirements.
- [x] Test valid current configuration; reject NaN, invalid bounds, unknown fields, invalid slugs, missing credits, missing region and missing default city.
- [x] Add workspaces and editor scripts, using existing Astro and TypeScript versions and only the required Leaflet/Geoman and Leaflet type dependencies.
- [x] Replace literal pipeline tables with compatibility exports; retain projection functions and openArea behavior.
- [x] Run shared tests and pipeline TypeScript checking.

### Task 2: Safe local API and bounded OSM inspection

**Files:** editor/astro.config.mjs, editor/server/{api.ts,store.ts,osm.ts}, editor/test/{store.test.ts,osm.test.ts,api.test.ts}.

**Interfaces:** GET `/api/editor/world` returns `{world, revision, locks: Record<string,string>}`. PUT same path accepts `{world, revision}`, returns the updated snapshot; errors use `{error:string}` with 400/403/409/413/502 as appropriate. POST `/api/editor/osm` accepts `{bbox: [south,west,north,east]}` and returns GeoJSON `{type:'FeatureCollection',features}`; feature properties include `osmType`, `osmId`, `category`, and `tags`.

- [x] Read disk on every snapshot/save. SHA-256 revision identifies exact file bytes. Serialize writes, check revision and validate before atomically renaming a unique adjacent temporary file; remove temporary files after errors. Reject removal of existing records, identifier/region reassignment that would orphan existing artifacts, and locked camera changes.
- [x] Detect locked cameras using local artifacts, published-state records and production world metadata. Lock israel-center unconditionally; lock uncertain production states with a reason. Recheck locks at save time.
- [x] Implement a same-origin JSON-only middleware with exact loopback Host validation, fixed routes, a 1 MiB body limit and no shell execution or user-supplied filesystem paths.
- [x] Bound OSM bbox dimensions, response size and timeout; serialize/cache upstream requests under data/raw/editor. Reject Overpass remarks and incomplete geometry. Convert nodes, ways and boundary/water relations to GeoJSON; preserve raw tags. Use explicit POST requests with an encoded query and fixed upstream URL.
- [x] Test stale and concurrent saves, atomic-write failure preservation, camera locking and record deletion, cross-origin requests, oversized bodies, invalid bbox, OSM categories, relation geometry, truncated/remark responses and upstream failure.
- [x] Run `npm -w editor test` and TypeScript checks.

### Task 3: Editor UI and integration

**Files:** editor/src/pages/index.astro, editor/src/{editor.ts,style.css}; editor/README.md; root README.md.

**Interfaces:** Consume the Task 2 endpoints and shared types. All draft changes stay in memory until explicit Save; reloading disk is explicit and confirms discarding dirty edits.

- [x] Build a responsive three-pane page: region/item navigation, map canvas and labeled properties form. Include connection/save status, Save and Reload controls and a feature inspector.
- [x] Render region origins/heading arrows, area rectangles and city markers. Use textContent for data-derived text. Provide form equivalents for all map operations.
- [x] Support new region/area/city forms, fixed saved identifiers, required metadata, airport fields, rectangle drawing/resizing, marker dragging, keyboard use and visible lock reasons. Keep unsaved drafts when switching items; confirm before page unload or reload.
- [x] Request OSM only on user action for a selected area, with loading/error states and layer checkboxes. Display clickable features and tags with missing heights explicitly identified. Keep fetched OSM out of saved configuration.
- [x] Start `npm run editor` on its own loopback port, verify in Playwright, and inspect a screenshot. Test creation/editing, area drawing, feature selection, mocked OSM failures and save/reopen using a temporary store or a no-change save so production definitions are preserved.
- [x] Run workspace tests, all affected TypeScript checks, editor build and public web build. Document launch commands, editing behavior and limitations.
- [x] Review the full diff, verify original definitions remain exact and report completed checks and any limits. No publishing or deployment.

## Validation results

### Follow-up: place search

- Added a submit-only Photon place/address search with selectable results and a temporary centered location marker. Selection leaves region definitions and camera coordinates untouched.
- Added `/api/editor/search` with existing same-origin checks, query/response limits, timeout, one-request-per-second limiting and a bounded 24-hour in-memory cache. No new dependency or API key.
- Load the local API through Vite's module runner so backend edits take effect without manually stopping the development server.
- Added search service/API tests and browser checks for no request while typing, keyboard result selection, actual marker centering, empty and error states, and unchanged saved configuration. All 26 unit tests and the full browser smoke pass; editor typecheck and build pass.
- Confirmed live Photon results for Haifa and successful recentering. Attribution and local-editor documentation include Photon, using the existing OSM credit.

- Shared and editor unit tests: 23 passing.
- Browser smoke: passed camera lock, rectangle drawing/resizing, city placement, OSM feature clicks/tags/layers/error states, creation/save/reopen, stale saves and mobile overflow checks. Saves used a temporary store; real definitions remained unchanged.
- Shared, editor, pipeline and web TypeScript checks: passed.
- Editor production UI build: passed.
- Public viewer build: passed with `TILES_ORIGIN=http://127.0.0.1:4322` to validate integration; this checkout has no configured production tile origin, so production tiles/previews were not verified.
- Original shared region/city/area values: exact byte comparison against the captured migration fixture passed.
- Independent review: approved after fixes for production metadata path, existing source-credit retention and linear river relation conversion.
- Live Overpass: initial service requests returned 406/502 or timed out; an identifying User-Agent was added. Availability remains external; the UI exposes failures and keeps them out of the completed cache.
- No publishing, deployment, pipeline execution or changes to protected data. Existing user changes were preserved.
