# Local region editor

## Goal

Browse OpenStreetMap data, create and edit regions, draw pipeline areas, and configure city opening views through a local browser application.

## Monorepo layout

Keep npm workspaces and the existing directory locations. No package-manager migration or monorepo build orchestrator is needed.

```text
editor/    Local Astro UI and Node.js API
shared/    Region, city and area types and editable configuration
pipeline/  Existing fetch, ground, scene, render, paint and export tools
web/       Existing public Astro and OpenSeadragon viewer
```

Register editor and shared in the root workspaces. Add `npm run editor` to start the editor independently of the public viewer. Preserve existing root commands.

## Stack and boundaries

Use TypeScript throughout, Astro for the editor page, Leaflet for the geographic map, and Leaflet-Geoman Free for drawing and editing rectangles and markers. Use a small Node.js API available only on loopback for local file access and OSM requests. Keep backend and browser code in editor, and do not ship filesystem access with the public viewer.

Use the existing OpenSeadragon viewer for painted-map inspection. The geographic editor does not replace the isometric viewer or introduce a second renderer.

## Shared configuration

Move region, city and area definitions into one checked-in JSON document in shared, with shared TypeScript types and runtime validation. Preserve existing identifiers, coordinates, camera settings, credits and optional airport data exactly. Keep the existing pipeline exports as compatibility entry points so callers retain their current interfaces. Preserve projection helpers and openArea behavior in pipeline.

The editor and pipeline must consume the same configuration. Do not generate TypeScript source from submitted form strings. Use one atomic file replacement for saving the full document, and reject saves when the loaded revision differs from the current file. A failed validation or conflicting save must leave the file unchanged.

## First-version interaction

The page has a region list, a geographic map and a properties panel. Selecting a region shows its origin, areas and city markers. Selecting an item opens its form. Unsaved changes are visible, and navigating away with changes requires confirmation.

Every selection centers the geographic view: fit all configured places for a region, the rectangle for an area, or the saved centre and opening width for a city view. Re-selecting the current item recenters it after panning. Navigation leaves saved geometry and camera settings unchanged.

Region fields: identifier on creation, title, origin latitude/longitude/height, camera heading, country, municipality names, credits and optional airport. Existing identifiers are fixed in this version. Area fields: identifier on creation, title, owning region and axis-aligned geographic rectangle. City fields: identifier on creation, title, owning region, centre and opening width in metres.

Support creating and editing these records. Do not include deletion in the first version. Display a heading arrow to explain camera direction; a live 3D camera preview is outside this scope.

## OSM inspection

The map includes an explicit place/address search using the Photon OpenStreetMap geocoder. Submit a query, then choose one of up to five results to center the view and show a temporary location marker. Searches do not alter the selected region, camera configuration or saved place definitions. Handle empty results, upstream failures and stale responses visibly. The loopback API validates queries, bounds upstream time/response size, caches repeated queries and limits requests to one per second. Retain OSM attribution and link Photon in the editor source note. No API key or additional package is needed.

Load OSM data explicitly for a selected area, rather than automatically requesting an entire region. Offer building, road, tree, water and boundary layers. Clicking a feature displays its OSM identifier and tags, including height and building levels when present. Distinguish missing heights from real measurements.

Use existing pipeline OSM query/cache helpers if their interfaces fit after inspection. Otherwise implement a bounded Overpass request through the local backend, with timeout, clear error messages and a local cache. Only return a completed response as usable data; do not silently accept truncated results. Keep raw OSM inspection data separate from editable place configuration.

Display the standard OpenStreetMap background immediately so areas can be located and drawn before detailed feature inspection. Retain visible © OpenStreetMap contributors attribution. Direct browser tile requests retain Referer and normal HTTP caching; no bulk download, offline caching or prefetch. Automated tests mock tiles. Record the source and usage policy in ATTRIBUTION.md. Show a visible message when background tiles fail. Use only open data. Any additional basemap provider requires a documented licence and the project-required source credits before inclusion.

## Validation and protection

Validate incoming documents on the server: finite coordinates within geographic ranges, south below north, west below east, positive city width, valid headings, unique lowercase ASCII hyphenated identifiers, valid region references and required credit lines. Reject unknown document structures and oversized requests.

Reject origin or heading changes for any region with generated tiles or paintings, local exported data, or recorded published state. The existing israel-center camera is locked from the start. When absence of existing production artifacts cannot be established, keep the camera locked and explain why. Enforce the restriction on the server as well as in the form.

Bind the API to loopback, require same-origin requests for writes, and accept structured configuration only. No endpoint may accept arbitrary paths or shell commands. Do not delete or rewrite derived images, published-state records or raw OSM data when saving configuration.

## Verification

Use small automated tests for validation, dangling region references, invalid bounding boxes, locked camera changes, stale-save rejection and atomic-save failure behavior. Verify that migrated definitions match current values exactly and existing pipeline consumers still typecheck.

In the browser, check region selection, feature tags, creating a region, drawing and resizing an area, setting a city centre, saving and reopening, keyboard access, visible attribution and readable OSM error states. Typecheck all affected workspaces and build the editor and public viewer.

## Scope exclusions

No React, database, hosted authentication, OSM uploads, painting controls, production publishing or deployment. No moving the existing web or pipeline folders. Preserve unrelated working-tree changes and the user's running dev server. Do not modify web files while a film render is active.

## Raw isometric build milestone

Saved areas can explicitly start the existing fetch, ground, scene and render commands through a detached local worker. One global disk-backed lock protects pipeline working files and configuration saves. Jobs expose persistent stage status and bounded log tails across reloads, with failure details and retry after all worker/stage processes exit. Fixed spawn arguments never accept arbitrary commands or paths.

Live build updates use GET /api/editor/builds/events with an optional area query, through the same loopback/same-origin checks. SSE sends the current full snapshot on connection and changed stage/status/log snapshots from watched worker files. Heartbeats reconcile stopped workers. Browser EventSource replaces polling, reconnects after dropped streams and initial HTTP failures, and preserves active-build locks across disconnects. Changing selection or starting a build closes the old stream; obsolete events cannot overwrite the latest state. Server watchers, heartbeat timers and slow-reader queues are cleaned up on disconnect; slow readers receive the latest state after draining.

Before reusing caches, verify saved input revision and area/camera provenance, including prior failed builds before a render manifest was written. Do not delete incompatible caches; require a new area identifier. Refuse areas larger than 0.25° per side. Verify every expected render and height image before reporting success, including when the renderer exits successfully after a per-tile error.

Compose an editor-only preview up to 4096 pixels on its longest side in data/editor, preserving original full-resolution tiles in data/derived. Show it in an OpenSeadragon dialog with a Raw render label and full source credits, including the required Copernicus text. This milestone does not run production export or change the public viewer cache. AI painting, publishing and deployment remain separate.
