# Local region editor

From the repository root:

```sh
npm install
npm run editor
```

Open http://127.0.0.1:4322. The editor runs independently of the public viewer. Its API is available only through this loopback development server; the static build is a UI build check, not a hosted administration app.

Select a region, area or city in the left sidebar. Properties update an in-memory draft. Draw area creates a rectangle; selecting an existing area exposes corner handles for resizing. Place city sets a new city view's centre. Numeric forms provide the same controls without using the map. Save changes writes the shared configuration; Reload from disk asks before discarding unsaved work. New regions need a country before saving. Existing identifiers and region ownership are fixed, and deletion is outside this version.

Selecting an item also centers the map: regions fit their areas and city views, areas fit their rectangle, and city views use their saved centre and view width. Re-selecting an item returns to it after panning elsewhere. This navigation does not change saved coordinates or camera settings.

Use the place/address field above the map and press Search (or Enter). Choose a result to center the map and mark the location. Searching only changes the geographic view; it leaves the selected region and saved camera untouched. A new region, area or city can then be created at that location using the existing controls. Searches use Photon's OpenStreetMap geocoder through the local API, with no API key. Requests happen only on submission, are limited to one per second, and repeat results are cached in memory for 24 hours. Public-service failures and empty results are shown beside the search field.

Configuration lives in `shared/src/world.json`, consumed by both the editor and the existing pipeline/viewer entry points. Review its diff before rendering. Saves are validated and atomically replace this one document. A revision check rejects stale saves from another tab or a changed file. Existing source credit lines must be retained; add new credits without removing the required existing lines. New data sources still require the project attribution workflow in AGENTS.md and ATTRIBUTION.md.

Origins and headings are locked when generated or published artifacts exist. Israel Center is always locked. `TILES_ORIGIN` from the environment or root `.env` lets the server check production metadata; if that check cannot establish absence, it conservatively locks the camera. A new region's initial camera can be set before its first save.

The geographic workspace displays the standard OpenStreetMap background immediately, so you can locate streets and draw new areas before fetching detailed features. Background tiles load directly in the browser with visible OSM attribution and normal browser caching. They are not downloaded for offline use or fed to the painting pipeline. A visible message identifies background-tile failures.

OSM feature inspection is explicit: select a small area and press Load area OSM. Toggle layers and click a fetched feature for its original OSM tags, or use the keyboard-accessible feature selector in the inspector. Missing heights are identified rather than invented. Requests are limited to 0.05° per bbox dimension, 35 seconds and 20 MiB; completed responses are cached for one hour in `data/raw/editor/`. Larger areas such as tlv-core need a smaller inspection patch. Upstream failures remain visible and can be retried.

```sh
npm run test:editor
npm run typecheck:editor
npm -w editor run build
# With the editor running and Chrome/Chromium installed:
npm -w editor run test:ui
```

Set `CHROME_PATH` for a nonstandard browser installation, `EDITOR_URL` for a different running editor URL, or `EDITOR_SCREENSHOT` for an optional smoke-test screenshot. Browser tests intercept configuration and OSM requests and save to a temporary directory; they do not alter real region definitions or rely on Overpass availability.

## Build an isometric preview

Select an area, save your changes, and click **Build isometric preview** in its properties panel. The editor runs the existing fetch → terrain → scene → render pipeline, then creates a zoomable raw preview. **View preview** opens the result, with pan/zoom controls and source credits. This is the geometric render; AI painting is a separate later step.

Chrome/Chromium is required. The editor detects common Mac/Linux installations, or uses `CHROME_PATH` from the environment or root `.env`. No tile-hosting credentials or ChatGPT login are needed for this raw build. Open-data downloads require internet access and can take time; upstream errors appear in the build log.

The stage list, expandable log and View preview button update live through server-sent events; no refresh is needed when a preview finishes. Jobs continue if you reload or close the browser, and their state is recovered from `data/editor/`. The stream reconnects automatically after network/server interruptions and restores the latest state. One build runs globally at a time because pipeline working files are shared. Configuration saves and geometry edits stay locked during the build, including during a disconnected stream. Failed/interrupted jobs offer **Retry build** when their processes have finished.

The local SSE API is `GET /api/editor/builds/events?area=<area-id>` (omit `area` for the global active build). It sends an immediate `build-state` event containing `{active, job}`, then changed stage/status/log snapshots as worker files change. Heartbeats run every 15 seconds and also reconcile stopped workers. Temporary read failures emit `build-error`; disconnecting releases the watcher and timers. Reconnecting starts with the current complete snapshot, so no event-history replay is required. The existing `GET /api/editor/builds` snapshot API remains available, but the browser no longer polls it.

Use areas no wider or taller than 0.25° per side; split larger regions into smaller patches. Start with a small test area. A build verifies saved inputs and existing cache provenance: if bounds or camera settings have changed since data was generated, use a new area identifier. Protected raw data, renders, paintings and published-state records are never deleted to make a build proceed. The renderer may log a failed tile while exiting normally; the editor checks every expected render and height tile before reporting success.

Full-resolution output remains in `data/derived/<area>/`. The preview image (up to 4096 pixels on its longest side), job metadata and logs live in `data/editor/jobs/<job-id>/`. Building a preview leaves the public export cache unchanged. Exporting to the public viewer remains a separate pipeline operation.

Automated build tests use fixture pipeline scripts and temporary directories. Browser smoke tests mock build/status/image requests; they verify controls, reload/retry and preview display without launching a real city build or using the public tile service during automated navigation.

Painting, publishing, deployment and OSM uploads are not available from the editor.
