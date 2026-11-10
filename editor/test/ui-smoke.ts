/** Browser integration against a running editor; all saves go to a temporary store. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { WORLD } from "../../shared/src/index.ts";
import { WorldStore } from "../server/store.ts";
import sharp from "sharp";
import type { BuildJob } from "../server/builds.ts";

const root = await mkdtemp(join(tmpdir(), "world-editor-ui-"));
await mkdir(join(root, "shared/src"), { recursive: true });
await writeFile(join(root, "shared/src/world.json"), JSON.stringify(WORLD));
const store = new WorldStore({ root, tilesOrigin: "https://tiles.example", fetch: (async () => new Response(null, { status: 404 })) as typeof fetch });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium"),
  headless: true,
});
let eventServer: ReturnType<typeof createServer> | undefined;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  let activeBuild: BuildJob | null = null;
  const latestBuilds = new Map<string, BuildJob>();
  let buildStarts = 0;
  let previewRequests = 0;
  let buildStatusGets = 0;
  let eventStreamsOpened = 0;
  let eventRequests = 0;
  let failedEventRequests = 1;
  let holdBuildEvents = false;
  const eventClients = new Map<ServerResponse, string | null>();
  const buildEvent = (area: string | null) => `event: build-state\ndata: ${JSON.stringify({ active: activeBuild, job: latestBuilds.get(area ?? "") ?? null })}\n\n`;
  const pushBuildUpdates = () => { for (const [response, area] of eventClients) response.write(buildEvent(area)); };
  eventServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
    response.write("retry: 100\n\n");
    const area = new URL(request.url!, "http://localhost").searchParams.get("area");
    eventClients.set(response, area);
    eventStreamsOpened++;
    response.on("close", () => eventClients.delete(response));
    if (!holdBuildEvents) response.write(buildEvent(area));
  });
  await new Promise<void>((resolve, reject) => { eventServer!.once("error", reject); eventServer!.listen(0, "127.0.0.1", resolve); });
  const eventOrigin = `http://127.0.0.1:${(eventServer.address() as AddressInfo).port}`;
  const previewImage = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#8b9b7e" } }).webp().toBuffer();
  const copernicus = "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved";
  await page.route("**/api/editor/builds**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/preview.webp")) { previewRequests++; await route.fulfill({ contentType: "image/webp", body: previewImage }); return; }
    if (url.pathname.endsWith("/events")) {
      eventRequests++;
      if (failedEventRequests > 0) { failedEventRequests--; await route.fulfill({ status: 500, json: { error: "Temporary stream setup failure" } }); return; }
      await route.fulfill({ status: 302, headers: { location: `${eventOrigin}/events${url.search}` } }); return;
    }
    if (route.request().method() === "GET") {
      buildStatusGets++;
      const response = structuredClone({ active: activeBuild, job: latestBuilds.get(url.searchParams.get("area") ?? "") ?? null });
      await route.fulfill({ json: response }); return;
    }
    const body = route.request().postDataJSON();
    const current = await store.snapshot();
    assert.equal(body.revision, current.revision);
    assert.ok(current.world.areas[body.area]);
    assert.equal(activeBuild, null);
    buildStarts++;
    activeBuild = { id: "11111111-1111-4111-8111-111111111111", area: body.area, region: current.world.areas[body.area].region, title: current.world.areas[body.area].title, status: "running", stage: "fetch", completedStages: [], startedAt: new Date().toISOString(), log: "Fetching open data…", credits: ["© OpenStreetMap contributors", copernicus] };
    latestBuilds.set(body.area, activeBuild);
    await route.fulfill({ status: 202, json: activeBuild });
  });
  let tileRequests = 0;
  await page.route("https://tile.openstreetmap.org/**", async route => {
    tileRequests++;
    await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64") });
  });
  let searchRequests = 0;
  let searchMode: "found" | "empty" | "error" = "found";
  await page.route("**/api/editor/search", async route => {
    searchRequests++;
    if (searchMode === "error") { await route.fulfill({ status: 502, json: { error: "Place search service is unavailable. Try again later." } }); return; }
    await route.fulfill({ json: searchMode === "empty" ? [] : [{ label: "Haifa, Israel", lat: 32.794, lon: 34.9896 }] });
  });
  await page.route("**/api/editor/world", async route => {
    try {
      const request = route.request();
      const result = request.method() === "PUT" ? await store.save(request.postDataJSON().world, request.postDataJSON().revision) : await store.snapshot();
      await route.fulfill({ json: result });
    } catch (error) {
      await route.fulfill({ status: 409, json: { error: error instanceof Error ? error.message : String(error) } });
    }
  });
  let failOsm = false;
  await page.route("**/api/editor/osm", async route => {
    if (failOsm) { await route.fulfill({ status: 502, json: { error: "Test upstream unavailable. Retry later." } }); return; }
    await route.fulfill({ json: { type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [34.775, 32.064] }, properties: { osmType: "node", osmId: 1, category: "trees", tags: { natural: "tree", name: "Test tree" } } },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[34.7745, 32.0635], [34.7755, 32.0635], [34.7755, 32.0645], [34.7745, 32.0645], [34.7745, 32.0635]]] }, properties: { osmType: "way", osmId: 2, category: "buildings", tags: { building: "yes", name: "Test building", "building:levels": "3" } } },
    ] } });
  });
  await page.goto(process.env.EDITOR_URL ?? "http://127.0.0.1:4322");
  await page.getByText("All changes saved", { exact: true }).waitFor();
  await page.getByText("Live build updates disconnected. Reconnecting…", { exact: true }).waitFor();
  await page.getByText("Select an area to build its raw isometric map.", { exact: true }).waitFor();
  assert.ok(eventRequests >= 2, "an initial HTTP500 must recover even when EventSource closes permanently");
  await page.locator(".leaflet-tile-loaded").first().waitFor();
  assert.ok(tileRequests > 0, "the geographic workspace must load its background map");
  assert.equal(await page.getByRole("link", { name: "© OpenStreetMap contributors", exact: true }).isVisible(), true);
  await page.getByRole("searchbox", { name: "Place or address", exact: true }).fill("Haifa");
  assert.equal(searchRequests, 0, "typing must not trigger geocoding");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const result = page.getByRole("button", { name: "Haifa, Israel", exact: true });
  await result.focus();
  await page.keyboard.press("Enter");
  const foundMarker = page.getByRole("button", { name: "Search result: Haifa, Israel", exact: true });
  await foundMarker.waitFor();
  await page.waitForTimeout(350);
  const foundBox = await foundMarker.boundingBox();
  const searchMapBox = await page.locator("#map").boundingBox();
  assert.ok(foundBox && searchMapBox);
  assert.ok(Math.abs(foundBox.x + foundBox.width / 2 - searchMapBox.x - searchMapBox.width / 2) < 3, JSON.stringify({ marker: foundBox, map: searchMapBox }));
  assert.ok(Math.abs(foundBox.y + foundBox.height / 2 - searchMapBox.y - searchMapBox.height / 2) < 3, JSON.stringify({ marker: foundBox, map: searchMapBox }));
  assert.equal(await page.getByText("All changes saved", { exact: true }).isVisible(), true, "searching must not change the region configuration");
  searchMode = "empty";
  await page.getByRole("searchbox", { name: "Place or address", exact: true }).fill("Unknown place");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText("No places found. Try a city, street or a more specific address.", { exact: true }).waitFor();
  searchMode = "error";
  await page.getByRole("searchbox", { name: "Place or address", exact: true }).fill("Unavailable place");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText("Place search service is unavailable. Try again later.", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Place or address", exact: true }).fill("");
  await page.getByRole("button", { name: "Fit region", exact: true }).click();
  assert.equal(await page.getByRole("spinbutton", { name: "Origin latitude", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "⊙ Tel Aviv-Yafo tel-aviv-yafo", exact: true }).click();
  const cityBox = await page.getByRole("button", { name: "Tel Aviv-Yafo city view", exact: true }).boundingBox();
  const cityMapBox = await page.locator("#map").boundingBox();
  assert.ok(cityBox && cityMapBox);
  assert.ok(Math.abs(cityBox.x + cityBox.width / 2 - cityMapBox.x - cityMapBox.width / 2) < 3, "selecting a city centers its saved view");
  assert.ok(Math.abs(cityBox.y + cityBox.height / 2 - cityMapBox.y - cityMapBox.height / 2) < 3);
  await page.locator("#region-item button").click();
  assert.equal(await page.locator("#map").evaluate(element => {
    const map = element.getBoundingClientRect();
    const paths = [...element.querySelectorAll(".leaflet-areas-pane path")];
    return paths.length > 0 && paths.every(path => { const bounds = path.getBoundingClientRect(); return bounds.left >= map.left && bounds.right <= map.right && bounds.top >= map.top && bounds.bottom <= map.bottom; });
  }), true, "selecting the current region fits all its areas");
  await page.getByRole("button", { name: "▱ Rothschild Blvd rothschild", exact: true }).click();
  assert.equal(await page.locator(".marker-icon").count(), 4);
  assert.equal(await page.locator("#map").evaluate(element => {
    const map = element.getBoundingClientRect();
    const corners = [...element.querySelectorAll(".marker-icon")].map(marker => marker.getBoundingClientRect());
    const x = corners.reduce((sum, b) => sum + b.x + b.width / 2, 0) / corners.length;
    const y = corners.reduce((sum, b) => sum + b.y + b.height / 2, 0) / corners.length;
    return Math.abs(x - map.x - map.width / 2) < 3 && Math.abs(y - map.y - map.height / 2) < 3;
  }), true, "selecting an area centers its bounds without pressing a separate zoom button");
  const east = await page.locator('#properties input[name="east"]').inputValue();
  const handle = await page.locator(".marker-icon").first().boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 14, handle.y + handle.height / 2 + 14, { steps: 5 });
  await page.mouse.up();
  const changedGeometry = await page.getByText("Unsaved changes", { exact: true }).isVisible();
  assert.ok(changedGeometry, `dragging a rectangle must update the draft (original east ${east})`);

  // Restore the fixture area through its numeric fields before loading known test geometry.
  for (const [name, value] of Object.entries({ south: "32.0605", west: "34.7705", north: "32.0675", east: "34.7795" })) await page.locator(`#properties input[name="${name}"]`).fill(value);
  await page.locator("#load-osm").click();
  await page.getByText("2 features loaded", { exact: false }).waitFor();
  // The fixture building and tree sit at the centre of these known bounds.
  await page.getByRole("button", { name: "Zoom to this area" }).click();
  await page.waitForTimeout(300);
  const mapBox = await page.locator("#map").boundingBox();
  assert.ok(mapBox);
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.getByRole("heading", { name: "Test building", exact: true }).waitFor();
  await page.getByText("No measured height tag. Building levels: 3.", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Buildings", exact: true }).uncheck();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.getByRole("heading", { name: "Test tree", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Inspect a feature", exact: true }).selectOption("1");
  await page.getByRole("heading", { name: "Test building", exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Trees", exact: true }).uncheck();
  failOsm = true;
  await page.locator("#load-osm").click();
  await page.getByText("Test upstream unavailable. Retry later.", { exact: true }).waitFor();

  async function create(kind: string, title: string) {
    await page.getByRole("button", { name: `New ${kind}`, exact: true }).click();
    await page.locator('#create-form input[name="title"]').fill(title);
    await page.getByRole("button", { name: "Create draft" }).click();
  }
  await create("region", "Editor Test Region");
  await page.locator('#properties input[name="country"]').fill("Israel");
  await page.locator('#properties input[name="heading"]').fill("35");
  await page.locator("#draw-area").click();
  const draftMap = await page.locator("#map").boundingBox();
  assert.ok(draftMap);
  await page.mouse.click(draftMap.x + draftMap.width / 2 - 60, draftMap.y + draftMap.height / 2 - 40);
  await page.mouse.move(draftMap.x + draftMap.width / 2 + 60, draftMap.y + draftMap.height / 2 + 40);
  await page.mouse.click(draftMap.x + draftMap.width / 2 + 60, draftMap.y + draftMap.height / 2 + 40);
  await page.locator('#create-form input[name="title"]').fill("Editor Test Patch");
  await page.getByRole("button", { name: "Create draft" }).click();
  assert.ok(Number(await page.locator('#properties input[name="north"]').inputValue()) > Number(await page.locator('#properties input[name="south"]').inputValue()));
  await page.locator("#place-city").click();
  await page.mouse.click(draftMap.x + draftMap.width / 2 + 120, draftMap.y + draftMap.height / 2 + 50);
  await page.locator('#create-form input[name="title"]').fill("Editor Test City");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.locator('#properties input[name="width"]').fill("4200");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  const saved = await store.snapshot();
  assert.equal(saved.world.regions["editor-test-region"].headingDeg, 35);
  assert.equal(saved.world.areas["editor-test-patch"].region, "editor-test-region");
  assert.equal(saved.world.cities["editor-test-city"].widthM, 4200);
  await page.reload();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Current region" }).selectOption("editor-test-region");
  assert.equal(await page.locator('#properties input[name="heading"]').inputValue(), "35");
  await page.getByRole("button", { name: "▱ Editor Test Patch editor-test-patch", exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector("#build-area") as HTMLButtonElement).disabled);
  await page.locator('#properties input[name="title"]').fill("Unsaved build title");
  assert.equal(await page.locator("#build-area").isDisabled(), true, "builds require saved inputs");
  await page.locator('#properties input[name="title"]').fill("Editor Test Patch");
  await page.getByRole("button", { name: "Build isometric preview", exact: true }).click();
  await page.getByText("Building Editor Test Patch · fetch… You can reload this page; the build continues.", { exact: true }).waitFor();
  assert.equal(buildStarts, 1);
  assert.equal(await page.locator("#save").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "New region", exact: true }).isDisabled(), true);
  assert.equal(await page.locator("#properties").evaluate(e => (e as HTMLElement).inert), true);
  const firstBuild = latestBuilds.get("editor-test-patch")!;
  firstBuild.stage = "render";
  firstBuild.completedStages = ["fetch", "ground", "scene"];
  firstBuild.log = "Rendering tile 1/1";
  pushBuildUpdates();
  await page.getByText("Building Editor Test Patch · render… You can reload this page; the build continues.", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Building Editor Test Patch. One pipeline build runs at a time.", { exact: true }).waitFor();
  assert.equal(buildStarts, 1, "reloading must attach to the job without launching another");
  await page.getByRole("combobox", { name: "Current region" }).selectOption("editor-test-region");
  await page.getByRole("button", { name: "▱ Editor Test Patch editor-test-patch", exact: true }).click();
  await page.getByText("Building Editor Test Patch · render… You can reload this page; the build continues.", { exact: true }).waitFor();
  const connectionsBeforeDrop = eventStreamsOpened;
  holdBuildEvents = true;
  for (const response of eventClients.keys()) response.end();
  await page.getByText("Live build updates disconnected. Reconnecting…", { exact: true }).waitFor();
  assert.equal(await page.locator("#properties").evaluate(e => (e as HTMLElement).inert), true, "disconnecting must preserve the active-build input lock");
  holdBuildEvents = false;
  pushBuildUpdates();
  await page.getByText("Building Editor Test Patch · render… You can reload this page; the build continues.", { exact: true }).waitFor();
  assert.ok(eventStreamsOpened > connectionsBeforeDrop, "native EventSource must reconnect without a refresh");
  firstBuild.status = "failed";
  firstBuild.message = "Fixture renderer failed";
  activeBuild = null;
  pushBuildUpdates();
  await page.getByRole("button", { name: "Retry build", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry build", exact: true }).click();
  await page.getByText("Building Editor Test Patch · fetch… You can reload this page; the build continues.", { exact: true }).waitFor();
  assert.equal(buildStarts, 2);
  const secondBuild = latestBuilds.get("editor-test-patch")!;
  secondBuild.status = "succeeded";
  secondBuild.stage = "preview";
  secondBuild.completedStages = ["fetch", "ground", "scene", "render", "preview"];
  secondBuild.previewUrl = "/api/editor/builds/11111111-1111-4111-8111-111111111111/preview.webp";
  activeBuild = null;
  pushBuildUpdates();
  const previewResponse = page.waitForResponse("**/api/editor/builds/*/preview.webp");
  await page.getByRole("button", { name: "View preview", exact: true }).click();
  await previewResponse;
  await page.getByRole("dialog", { name: "Editor Test Patch", exact: true }).waitFor();
  await page.locator("#render-preview canvas").first().waitFor();
  assert.equal(await page.locator("#render-preview-error").isHidden(), true);
  assert.ok(previewRequests > 0);
  assert.match(await page.locator("#render-preview-credits").textContent() ?? "", /provided under COPERNICUS by the European Union and ESA; all rights reserved/);
  await page.getByRole("button", { name: "Fit preview", exact: true }).click();
  await page.getByRole("button", { name: "Close isometric preview", exact: true }).click();
  await page.locator("#region-item button").click();
  await page.locator('#properties input[name="title"]').fill("Unsaved conflicting title");
  const external = await store.snapshot();
  external.world.regions["editor-test-region"].title = "External edit";
  await store.save(external.world, external.revision);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Configuration changed on disk. Reload before saving.", { exact: true }).waitFor();
  assert.equal((await store.snapshot()).world.regions["editor-test-region"].title, "External edit");
  assert.equal(await page.getByText("Unsaved changes", { exact: true }).isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.EDITOR_SCREENSHOT });
  assert.deepEqual(errors, []);
  assert.equal(buildStatusGets, 0, "build updates must use SSE, not status polling");
  const original = JSON.parse(await readFile(new URL("../../shared/src/world.json", import.meta.url), "utf8"));
  assert.deepEqual(original, WORLD, "Browser tests must not modify real configuration");
  console.log("PASS: SSE updates/reconnection/no polling, build controls/reload/retry/preview/credits, search, selection, drawing, OSM inspection and save conflicts; real configuration unchanged.");
} finally {
  await browser.close();
  if (eventServer) { eventServer.closeAllConnections(); await new Promise<void>(resolve => eventServer!.close(() => resolve())); }
  await rm(root, { recursive: true, force: true });
}
