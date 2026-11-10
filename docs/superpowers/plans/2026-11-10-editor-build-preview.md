# Editor Build Preview Implementation Plan

**Goal:** A saved area can build a raw isometric map locally, show persistent stage logs and retry failures, then open a zoomable preview.

**Architecture:** Reuse pipeline fetch, ground, scene and render commands in a detached Node worker. Generate an editor-only preview from the complete manifest and render PNGs, under data/editor, without invoking the production export, paint, publish or deploy commands. The full-resolution source tiles remain in data/derived. A disk-backed global lock prevents overlapping use of pipeline shared files. Snapshot revisions and a save lock protect running inputs.

**Tech Stack:** Existing Node/TypeScript, Astro/Vite API middleware, sharp and OpenSeadragon. No queue service, database or new external data source.

## Constraints

- Preserve all existing user changes, protected data and existing servers. No web source edits.
- Builds start explicitly from a saved area; no build on page load or polling.
- Node spawn uses fixed executable/script arguments with no shell or user paths.
- Build status and logs survive browser/server reloads. Dead workers show interrupted/failed status and allow retry, never false success.
- One pipeline build globally at a time, bounded area size; no overlapping generated data writes.
- Refuse a reused area whose existing manifest bounds/camera conflict with current inputs; do not silently reuse stale tiles.
- Check every expected render tile exists and decodes before reporting success: render.ts can log tile errors while exiting successfully.
- Keep complete source credits visible in the raw preview, including © OpenStreetMap contributors and the full Copernicus DEM text from ATTRIBUTION.md. Clearly label Raw render.

## Task 1: Durable build backend

Owner: implementation agent; files editor/server/build*.ts, editor/test/build*.test.ts, editor/server/api.ts and editor/test/api.test.ts only.

Interfaces:

```ts
type BuildStage = 'fetch'|'ground'|'scene'|'render'|'preview';
type BuildJob = {
  id: string; area: string; region: string; title: string;
  status: 'running'|'succeeded'|'failed'|'interrupted';
  stage: BuildStage; completedStages: BuildStage[];
  startedAt: string; finishedAt?: string; message?: string;
  log: string; previewUrl?: string;
  credits: string[];
};
// GET /api/editor/builds?area=<optional area id>
type BuildSnapshot = {active: BuildJob|null; job: BuildJob|null};
// POST /api/editor/builds {area:string, revision:string} -> BuildJob (202)
// GET /api/editor/builds/<uuid>/preview.webp -> fixed local image bytes
```

- [x] Read fresh validated configuration, verify saved revision, known safe area ID, bounds <=0.25° each dimension, browser/tsx availability and compatible prior manifest. Never accept arbitrary commands/paths.
- [x] Acquire exclusive disk lock, write per-job immutable input metadata, spawn and detach a fixed worker, persist pid/stage/completion state atomically, append logs and expose a bounded tail.
- [x] Recheck input revision before/after each stage. Run fixed CLI stages with process.execPath and the existing tsx loader. Detect Chrome/Chromium on this platform or respect CHROME_PATH/.env. Do not use --force.
- [x] Generate a maximum 4096-pixel preview mosaic using sharp from all manifest tile coordinates; reject zero/missing/corrupt tiles. Never write protected paintings, published state or public export cache.
- [x] GET status reconciles stale/dead workers safely; API PUT world rejects saves during active jobs. Binary preview serving only for known successful jobs. Validate all routes, same-origin writes and request shapes.
- [x] Test stage ordering, real detached fixture worker, concurrency, stale revision, failed stage/retry, reload reattachment, missing/corrupt render output, fixed-path image serving and unchanged protected/config files. All test output uses temporary roots.

## Task 2: Area build UI and zoomable preview

Owner: parent; editor/src/{editor.ts,style.css,pages/index.astro}, editor/package.json and lock, editor/test/ui-smoke.ts, docs.

- [x] Add Build isometric preview, View preview and retry behavior for selected areas. Require saved draft. Poll the read-only status endpoint every 2 seconds, including on reload; never auto-start work.
- [x] Show current stage/completed stages, status, error and expandable log tail. Explain global build ownership when another area runs. Disable saves and geometry edits while active.
- [x] Open a dialog with OpenSeadragon simple-image source, title, Raw render label and required credits. No web edits or publishing.
- [x] Browser tests mock job endpoints and image tiles; cover saved-only builds, polling, completion, preview/credits, failures/retry, active-job controls and reload reattachment. Unit tests cover real detached runner using fixture scripts.
- [x] Run affected typechecks, backend tests, UI smoke and editor build. Review backend with an independent reviewer and preserve unrelated edits.

## Progress

### Follow-up: server-sent build events

- [x] Add same-origin GET /api/editor/builds/events with optional area and initial full BuildSnapshot.
- [x] Push changed snapshots from native filesystem notifications, debounce bursts, bound output through existing log tails, and pause updates for socket backpressure. Heartbeats every 15 seconds reconcile stopped workers.
- [x] Replace the browser's two-second polling with native EventSource; close obsolete streams on selection/start/pagehide and guard generations. Restore the latest full snapshot on reconnection; explicitly recreate CLOSED connections after initial HTTP failures.
- [x] Preserve active input locks while disconnected. Update progress, logs, failures and View preview automatically without a page refresh.
- [x] Test atomic worker-file updates, deduplication, unchanged-snapshot error recovery, backpressure and cleanup. Native browser tests cover initial HTTP 500 recovery, dropped-stream reconnect, zero status-poll requests and full build/preview flows.

Validation: 43 tests pass (10 shared + 33 editor); native fs.watch tests need host access because this execution sandbox reports EMFILE for watchers. Native-browser SSE smoke, shared/editor typechecks and editor build pass. A live local EventSource received its initial snapshot; no real area build was started.

Complete. Independent review approved spec compliance and code quality after fixes for stage ownership, orphan writers, pre-manifest cache provenance, and stale browser polling responses.

Validation: 40 unit/integration tests pass (10 shared + 30 editor), including real detached fixture workers and Vite SSR launch; browser smoke passes saved-input gating, stage/log updates, reload reattachment, failure/retry, zoomable preview and required credits. Shared/editor/pipeline/web typechecks and editor build pass. The local UI shows Build isometric preview for saved areas.

Tests use temporary roots and mocked browser job/tile/image endpoints. A real area's open-data download/render was not started automatically. No paint, production export, publishing or deployment ran. The user's newly saved kohav-yair area was preserved.
