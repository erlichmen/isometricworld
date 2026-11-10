import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import type { Area, City, Region, World } from "../../shared/src/index.ts";
import { validateWorld } from "../../shared/src/validate.ts";
import type { FeatureCollection } from "../server/osm.ts";
import type { PlaceResult } from "../server/search.ts";
import { setupBuildPanel } from "./build-panel.ts";

type Kind = "region" | "area" | "city";
type Selection = { kind: Kind; id: string };
type Snapshot = { world: World; revision: string; locks: Record<string, string> };
type Bbox = Area["bbox"];
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => get<HTMLButtonElement>(id);
const make = <T extends keyof HTMLElementTagNameMap>(tag: T, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const tables = { region: "regions", area: "areas", city: "cities" } as const;
const form = get<HTMLFormElement>("properties");
const dialog = get<HTMLDialogElement>("create-dialog");
const createForm = get<HTMLFormElement>("create-form");
const regionSelect = get<HTMLSelectElement>("region-select");
let snapshot: Snapshot;
let world: World;
let baseline = "";
let selection: Selection;
let regionId = "";
let saving = false;
let osmBusy = false;
let osmGeneration = 0;
let osmData: FeatureCollection | undefined;
let osmBounds = "";
let tool: "area" | "city" | undefined;
let pendingCreation: { kind: Kind; bbox?: Bbox; center?: City["center"] };
let manualSlug = false;
let buildActive = false;

const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 2, maxZoom: 20 }).setView([32.0778, 34.774], 13);
L.control.zoom({ position: "topright" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>');
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxNativeZoom: 19,
  maxZoom: 20,
  keepBuffer: 0,
  updateWhenIdle: true,
  referrerPolicy: "strict-origin-when-cross-origin",
}).on("loading", () => { get("basemap-status").hidden = true; })
  .on("tileerror", () => { get("basemap-status").hidden = false; })
  .addTo(map);
const objects = L.featureGroup().addTo(map);
const osmLayers = L.layerGroup().addTo(map);
let searchMarker: L.Marker | undefined;
// SVG outlines leave the interior clickable for OSM features beneath them.
map.createPane("areas").style.zIndex = "450";
const areaRenderer = L.svg({ pane: "areas" });
const colors = { buildings: "#a68e6b", roads: "#929a83", trees: "#6a915e", water: "#79a9b1", boundaries: "#9a80a6" };
const rounded = (n: number) => Number(n.toFixed(7));
const centerAt = (latlng: L.LatLng): City["center"] => [rounded(latlng.lat), rounded(latlng.lng)];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/editor/${path}`, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

const searchForm = get<HTMLFormElement>("place-search-form");
const searchInput = get<HTMLInputElement>("place-query");
const searchList = get("place-result-list");
let searchGeneration = 0;
searchInput.addEventListener("input", () => {
  searchGeneration++;
  get("place-search-results").hidden = true;
  searchList.replaceChildren();
  button("search-place").disabled = false;
  button("search-place").textContent = "Search";
});
searchForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!searchForm.reportValidity()) return;
  const generation = ++searchGeneration;
  get("place-search-results").hidden = false;
  get("place-search-status").textContent = "Searching places…";
  searchList.replaceChildren();
  button("search-place").disabled = true;
  button("search-place").textContent = "Searching…";
  try {
    const results = await api<PlaceResult[]>("search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: searchInput.value }) });
    if (generation !== searchGeneration) return;
    get("place-search-status").textContent = results.length ? "Choose a place to center the map." : "No places found. Try a city, street or a more specific address.";
    for (const result of results) {
      const item = make("li");
      const choice = make("button", result.label);
      choice.type = "button";
      choice.addEventListener("click", () => {
        cancelTool();
        map.setView([result.lat, result.lon], 15, { animate: false });
        searchMarker?.remove();
        searchMarker = L.marker([result.lat, result.lon], {
          pmIgnore: true,
          icon: L.divIcon({ className: "map-pin", html: '<span class="pin-inner selected">⌖</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
        }).addTo(map).bindTooltip(tooltip(result.label));
        searchMarker.getElement()?.setAttribute("aria-label", `Search result: ${result.label}`);
        searchInput.value = result.label.slice(0, 200);
        get("place-search-results").hidden = true;
        get("map-hint").textContent = result.label;
        get("map").focus();
      });
      item.append(choice);
      searchList.append(item);
    }
  } catch (error) {
    if (generation === searchGeneration) get("place-search-status").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === searchGeneration) { button("search-place").disabled = false; button("search-place").textContent = "Search"; }
  }
});

function notice(message = "") {
  get("notice").hidden = !message;
  get("notice").textContent = message;
}

function dirty() { return !!world && JSON.stringify(world) !== baseline; }
function updateState() {
  get("save-state").textContent = saving ? "Saving…" : dirty() ? "Unsaved changes" : "All changes saved";
  button("save").disabled = saving || buildActive || !dirty();
  button("reload").disabled = saving;
  for (const id of ["new-region", "new-area", "new-city", "draw-area", "place-city"]) button(id).disabled = !world || buildActive;
  buildPanel.update();
}

function updateDraft() {
  notice();
  updateState();
  renderNavigation();
  renderMap();
}

function selectedItem(): Region | Area | City {
  return world[tables[selection.kind]][selection.id];
}

function changeSelection(next: Selection) {
  cancelTool();
  const nextRegion = next.kind === "region" ? next.id : (world[tables[next.kind]][next.id] as Area | City).region;
  const changedRegion = regionId !== nextRegion;
  const changedArea = selection?.kind === "area" || next.kind === "area";
  selection = next;
  regionId = nextRegion;
  if (changedRegion || changedArea) clearOsm();
  renderNavigation();
  renderProperties();
  renderMap();
  fitSelection();
  buildPanel.update();
  void buildPanel.refresh();
}

function navItem(kind: Kind, id: string, title: string, subtitle: string) {
  const node = make("button", undefined, `nav-item${selection.kind === kind && selection.id === id ? " selected" : ""}`);
  node.type = "button";
  node.setAttribute("aria-pressed", String(selection.kind === kind && selection.id === id));
  node.append(make("span", kind === "region" ? "◇" : kind === "area" ? "▱" : "⊙", "nav-icon"));
  const text = make("span", undefined, "nav-text");
  text.append(make("strong", title), make("small", subtitle));
  node.append(text);
  node.addEventListener("click", () => changeSelection({ kind, id }));
  return node;
}

function renderNavigation() {
  const region = world.regions[regionId];
  regionSelect.replaceChildren(...Object.entries(world.regions).map(([id, r]) => new Option(r.title, id)));
  regionSelect.value = regionId;
  get("region-item").replaceChildren(navItem("region", regionId, region.title, snapshot.locks[regionId] ? "Camera locked" : "Camera & metadata"));
  for (const kind of ["area", "city"] as const) {
    const items = Object.entries(world[tables[kind]]).filter(([, item]) => item.region === regionId);
    get(`${kind}-list`).replaceChildren(...(items.length
      ? items.map(([id, item]) => navItem(kind, id, item.title, id))
      : [make("p", kind === "area" ? "No areas yet. Draw your first patch." : "No city views yet.", "empty-list")]));
  }
  get("map-title").textContent = region.title;
  const area = selection.kind === "area" ? world.areas[selection.id] : undefined;
  button("load-osm").disabled = !area || osmBusy;
  if (!osmData && !osmBusy) get("osm-status").textContent = area
    ? `Inspect ${area.title}. Loads a bounded open-data snapshot; large areas need a smaller patch.`
    : "Choose an area to inspect buildings, streets and natural features.";
}

function field(label: string, name: string, value: string | number, options: { type?: string; disabled?: boolean; multiline?: boolean; required?: boolean; help?: string; min?: number; max?: number } = {}) {
  const wrapper = make("label", label, "field");
  const input = options.multiline ? make("textarea") : make("input");
  input.name = name;
  input.value = String(value);
  input.disabled = options.disabled ?? false;
  input.required = options.required ?? true;
  if (input instanceof HTMLInputElement) {
    input.type = options.type ?? (typeof value === "number" ? "number" : "text");
    if (input.type === "number") input.step = "any";
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
  }
  wrapper.append(input);
  if (options.help) wrapper.append(make("small", options.help));
  return wrapper;
}

function section(title: string) {
  const node = make("div", undefined, "form-section");
  node.append(make("p", title, "form-section-title"));
  form.append(node);
  return node;
}

function row(...fields: HTMLElement[]) {
  const node = make("div", undefined, "field-row");
  node.append(...fields);
  return node;
}

function renderProperties() {
  const item = selectedItem();
  get("item-kind").textContent = selection.kind.toUpperCase();
  get("item-title").textContent = item.title;
  get("item-description").textContent = selection.kind === "region" ? "One camera. A continuous world." : selection.kind === "area" ? "A rectangular patch to fetch, render and paint." : "A named opening view into the region.";
  form.replaceChildren();
  form.inert = buildActive;
  form.append(field("Identifier", "id", selection.id, { disabled: true }), field("Title", "title", item.title));
  const lock = selection.kind === "region" ? snapshot.locks[selection.id] : undefined;
  get("lock-note").hidden = !lock;
  get("lock-note").textContent = lock ? `Camera locked · ${lock}` : "";
  if (selection.kind === "region") {
    const region = item as Region;
    const camera = section("CAMERA");
    camera.append(row(field("Origin latitude", "lat", region.origin.lat, { disabled: !!lock, min: -90, max: 90 }), field("Origin longitude", "lon", region.origin.lon, { disabled: !!lock, min: -180, max: 180 })));
    camera.append(row(field("Origin height (m)", "height", region.origin.h, { disabled: !!lock, min: -12000, max: 10000 }), field("Heading (°)", "heading", region.headingDeg, { disabled: !!lock, min: 0, max: 359.999999 })));
    const metadata = section("REGION DETAILS");
    metadata.append(field("Country", "country", region.country, { help: "OSM country name:en, e.g. Israel." }), field("Municipalities", "municipalities", region.municipalities.join("\n"), { multiline: true, required: false, help: "One exact OSM municipality name per line." }), field("Credits", "credits", region.credits.join("\n"), { multiline: true, help: "Keep the required OSM, Copernicus DEM and AI credits." }));
    const airport = section("AIRPORT · OPTIONAL");
    const label = make("label", undefined, "field-check");
    const check = make("input");
    check.type = "checkbox";
    check.name = "airportEnabled";
    check.checked = !!region.airport;
    label.append(check, document.createTextNode("Show an arriving airliner"));
    airport.append(label);
    check.addEventListener("change", () => {
      if (check.checked) region.airport = { lat: region.origin.lat, lon: region.origin.lon, runwayHeadingDeg: region.headingDeg };
      else delete region.airport;
      updateState();
      renderProperties();
    });
    if (region.airport) {
      airport.append(row(field("Runway latitude", "airportLat", region.airport.lat, { min: -90, max: 90 }), field("Runway longitude", "airportLon", region.airport.lon, { min: -180, max: 180 })), field("Runway heading (°)", "airportHeading", region.airport.runwayHeadingDeg, { min: 0, max: 359.999999 }));
    }
  } else if (selection.kind === "area") {
    const a = item as Area;
    const bounds = section("GEOGRAPHIC BOUNDS");
    bounds.append(row(field("South", "south", a.bbox[0], { min: -90, max: 90 }), field("West", "west", a.bbox[1], { min: -180, max: 180 })), row(field("North", "north", a.bbox[2], { min: -90, max: 90 }), field("East", "east", a.bbox[3], { min: -180, max: 180 })));
    bounds.append(make("p", "Drag the corner handles on the map to resize. Changes stay in your draft until saved.", "muted"));
    const zoom = make("button", "Zoom to this area", "outline full");
    zoom.type = "button";
    zoom.addEventListener("click", fitSelection);
    bounds.append(zoom);
  } else {
    const city = item as City;
    const view = section("OPENING VIEW");
    view.append(row(field("Centre latitude", "lat", city.center[0], { min: -90, max: 90 }), field("Centre longitude", "lon", city.center[1], { min: -180, max: 180 })), field("View width (m)", "width", city.widthM, { min: 0.01, max: 300000, help: "Drag the city marker to move its opening view." }));
  }
}

const lines = (s: string) => s.split("\n").map(v => v.trim()).filter(Boolean);
form.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") return;
  const item = selectedItem();
  const data = new FormData(form);
  const str = (name: string) => String(data.get(name) ?? "");
  const num = (name: string) => str(name).trim() === "" ? NaN : Number(str(name));
  item.title = str("title");
  if (selection.kind === "region") {
    const r = item as Region;
    if (!snapshot.locks[selection.id]) { r.origin = { lat: num("lat"), lon: num("lon"), h: num("height") }; r.headingDeg = num("heading"); }
    r.country = str("country");
    r.municipalities = lines(str("municipalities"));
    r.credits = lines(str("credits"));
    if (r.airport) r.airport = { lat: num("airportLat"), lon: num("airportLon"), runwayHeadingDeg: num("airportHeading") };
  } else if (selection.kind === "area") {
    (item as Area).bbox = [num("south"), num("west"), num("north"), num("east")];
    clearOsm();
  } else { const c = item as City; c.center = [num("lat"), num("lon")]; c.widthM = num("width"); }
  get("item-title").textContent = item.title;
  updateDraft();
});
form.addEventListener("submit", e => e.preventDefault());

function validPoint(point: number[]) { return point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180; }
function validBounds(b: Bbox) { return validPoint([b[0], b[1]]) && validPoint([b[2], b[3]]) && b[0] < b[2] && b[1] < b[3]; }
function icon(kind: "region" | "city", selected: boolean) {
  return L.divIcon({ className: "map-pin", html: `<span class="pin-inner ${kind}${selected ? " selected" : ""}">${kind === "region" ? "◇" : "•"}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
function tooltip(title: string) { return make("span", title); }

function geometryChanged() {
  clearOsm();
  updateState();
  renderProperties();
}

function renderMap() {
  objects.clearLayers();
  const region = world.regions[regionId];
  if (validPoint([region.origin.lat, region.origin.lon])) {
    const marker = L.marker([region.origin.lat, region.origin.lon], { icon: icon("region", selection.kind === "region"), draggable: !buildActive && selection.kind === "region" && !snapshot.locks[regionId], pmIgnore: true });
    marker.bindTooltip(tooltip(`${region.title} · origin`));
    marker.on("add", () => marker.getElement()?.setAttribute("aria-label", `${region.title} region origin`));
    marker.on("click", () => changeSelection({ kind: "region", id: regionId }));
    marker.on("dragend", () => { const [lat, lon] = centerAt(marker.getLatLng()); region.origin.lat = lat; region.origin.lon = lon; geometryChanged(); renderMap(); });
    objects.addLayer(marker);
    if (Number.isFinite(region.headingDeg)) {
      const arrow = make("span", "↑");
      arrow.style.display = "block";
      arrow.style.transform = `rotate(${region.headingDeg}deg)`;
      objects.addLayer(L.marker([region.origin.lat, region.origin.lon], { interactive: false, pmIgnore: true, icon: L.divIcon({ className: "heading-pin", html: arrow, iconSize: [30, 30], iconAnchor: [15, 46] }) }));
    }
  }
  for (const [id, area] of Object.entries(world.areas)) {
    if (area.region !== regionId || !validBounds(area.bbox)) continue;
    const selected = selection.kind === "area" && selection.id === id;
    const rectangle = L.rectangle([[area.bbox[0], area.bbox[1]], [area.bbox[2], area.bbox[3]]], { renderer: areaRenderer, color: selected ? "#557744" : "#8b9b7e", weight: selected ? 2 : 1, fill: false, dashArray: selected ? undefined : "6 5", pmIgnore: false });
    rectangle.bindTooltip(tooltip(area.title), { direction: "center" });
    rectangle.on("click", () => { if (!selected) changeSelection({ kind: "area", id }); });
    rectangle.on("pm:edit", () => {
      const b = rectangle.getBounds();
      area.bbox = [rounded(b.getSouth()), rounded(b.getWest()), rounded(b.getNorth()), rounded(b.getEast())];
      geometryChanged();
    });
    objects.addLayer(rectangle);
    if (selected && !buildActive) rectangle.pm.enable({ snappable: false, allowSelfIntersection: false });
  }
  for (const [id, city] of Object.entries(world.cities)) {
    if (city.region !== regionId || !validPoint(city.center)) continue;
    const selected = selection.kind === "city" && selection.id === id;
    const marker = L.marker(city.center, { icon: icon("city", selected), draggable: selected && !buildActive, pmIgnore: true });
    marker.bindTooltip(tooltip(city.title), { direction: "right" });
    marker.on("add", () => marker.getElement()?.setAttribute("aria-label", `${city.title} city view`));
    marker.on("click", () => changeSelection({ kind: "city", id }));
    marker.on("dragend", () => { city.center = centerAt(marker.getLatLng()); geometryChanged(); });
    objects.addLayer(marker);
  }
}

function fitRegion() {
  const bounds = objects.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.1), { padding: [55, 55], maxZoom: 14, animate: false });
}

function fitSelection() {
  if (selection.kind === "region") { fitRegion(); return; }
  if (selection.kind === "area") {
    const b = world.areas[selection.id].bbox;
    if (validBounds(b)) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [65, 65], animate: false });
  } else {
    const city = world.cities[selection.id];
    if (validPoint(city.center) && Number.isFinite(city.widthM) && city.widthM > 0) {
      map.fitBounds(L.latLng(city.center).toBounds(city.widthM), { padding: [55, 55], maxZoom: 18, animate: false });
    }
  }
}

function cancelTool() {
  tool = undefined;
  map.pm.disableDraw();
  get("map").style.cursor = "";
  button("cancel-tool").hidden = true;
  button("draw-area").classList.remove("active");
  button("place-city").classList.remove("active");
  get("map-hint").textContent = "Select an area, then load its OSM features below.";
}

button("draw-area").addEventListener("click", () => {
  cancelTool();
  tool = "area";
  map.pm.enableDraw("Rectangle", { snappable: false, continueDrawing: false });
  button("draw-area").classList.add("active");
  button("cancel-tool").hidden = false;
  get("map-hint").textContent = "Click two opposite corners to draw a new area. Escape cancels.";
});
map.on("pm:create", event => {
  if (event.shape !== "Rectangle") return;
  const layer = event.layer as L.Rectangle;
  const b = layer.getBounds();
  map.removeLayer(layer);
  cancelTool();
  openCreate("area", { bbox: [rounded(b.getSouth()), rounded(b.getWest()), rounded(b.getNorth()), rounded(b.getEast())] });
});
button("place-city").addEventListener("click", () => {
  cancelTool();
  tool = "city";
  get("map").style.cursor = "crosshair";
  button("place-city").classList.add("active");
  button("cancel-tool").hidden = false;
  get("map-hint").textContent = "Click the map to set the new city's opening centre. Escape cancels.";
});
map.on("click", event => {
  if (tool === "city") { cancelTool(); openCreate("city", { center: centerAt(event.latlng) }); }
});
map.on("mousemove", e => { get("coordinates").textContent = `${e.latlng.lat.toFixed(5)}°, ${e.latlng.lng.toFixed(5)}° · WGS84`; });
button("cancel-tool").addEventListener("click", cancelTool);
document.addEventListener("keydown", e => { if (e.key === "Escape") cancelTool(); });
button("fit").addEventListener("click", fitRegion);
regionSelect.addEventListener("change", () => changeSelection({ kind: "region", id: regionSelect.value }));
window.addEventListener("beforeunload", e => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
document.querySelector<HTMLAnchorElement>(".brand")!.addEventListener("click", e => {
  if (dirty() && !confirm("Discard unsaved changes and leave the editor?")) e.preventDefault();
});

function openCreate(kind: Kind, geometry: { bbox?: Bbox; center?: City["center"] } = {}) {
  pendingCreation = { kind, ...geometry };
  manualSlug = false;
  createForm.reset();
  get("create-error").textContent = "";
  get("create-title").textContent = `New ${kind === "city" ? "city view" : kind}`;
  get("create-description").textContent = kind === "region" ? "Start a new map at the current map centre. Complete its country and credits before saving." : kind === "area" ? "Define a new patch in this region. You can refine its bounds on the map." : "Give this view a name. Its identifier becomes the city's URL.";
  dialog.showModal();
}
for (const kind of ["region", "area", "city"] as const) button(`new-${kind}`).addEventListener("click", () => openCreate(kind));
button("cancel-create").addEventListener("click", () => dialog.close());
const createTitle = createForm.elements.namedItem("title") as HTMLInputElement;
const createId = createForm.elements.namedItem("id") as HTMLInputElement;
createId.addEventListener("input", () => { manualSlug = true; });
createTitle.addEventListener("input", () => {
  if (!manualSlug) createId.value = createTitle.value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
});
createForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!createForm.reportValidity()) return;
  const id = createId.value;
  const title = createTitle.value.trim();
  const { kind } = pendingCreation;
  if (Object.hasOwn(world[tables[kind]], id) || ["constructor", "prototype"].includes(id)) { get("create-error").textContent = "That identifier is already used or reserved. Choose another."; return; }
  const center = pendingCreation.center ?? centerAt(map.getCenter());
  if (kind === "region") {
    world.regions[id] = { title, origin: { lat: center[0], lon: center[1], h: 0 }, headingDeg: 30, country: "", municipalities: [], credits: ["Map data © OpenStreetMap contributors", "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI"] };
  } else if (kind === "area") {
    world.areas[id] = { title, region: regionId, bbox: pendingCreation.bbox ?? [rounded(Math.max(-90, center[0] - 0.005)), rounded(Math.max(-180, center[1] - 0.005)), rounded(Math.min(90, center[0] + 0.005)), rounded(Math.min(180, center[1] + 0.005))] };
  } else world.cities[id] = { title, region: regionId, center, widthM: 5200 };
  dialog.close();
  changeSelection({ kind, id });
  updateState();
});

function clearOsm() {
  osmGeneration++;
  osmBusy = false;
  osmData = undefined;
  osmBounds = "";
  osmLayers.clearLayers();
  button("load-osm").textContent = "Load area OSM ↓";
  button("load-osm").disabled = selection?.kind !== "area";
  get("feature-title").textContent = "A closer look";
  get("feature-picker").hidden = true;
  get<HTMLSelectElement>("feature-select").replaceChildren(new Option("Choose a feature…", ""));
  get("feature-details").replaceChildren(make("p", "Load OSM data and click a feature to see its original tags.", "muted"));
}

function inspectFeature(properties: FeatureCollection["features"][number]["properties"]) {
  const { osmType, osmId, tags, category } = properties;
  get("feature-title").textContent = tags.name || `${osmType} ${osmId}`;
  const details = get("feature-details");
  details.replaceChildren();
  const link = make("a", `Open ${osmType} ${osmId} on OpenStreetMap ↗`, "feature-link");
  link.href = `https://www.openstreetmap.org/${osmType}/${osmId}`;
  link.target = "_blank";
  link.rel = "noopener";
  details.append(link);
  if (category === "buildings" && !tags.height) details.append(make("p", tags["building:levels"] ? `No measured height tag. Building levels: ${tags["building:levels"]}.` : "Height unknown · no height or building:levels tag.", "muted"));
  const table = make("table", undefined, "tag-table");
  for (const [key, value] of Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))) {
    const row = make("tr");
    const th = make("th", key);
    th.scope = "row";
    row.append(th, make("td", value));
    table.append(row);
  }
  details.append(table);
}

get<HTMLSelectElement>("feature-select").addEventListener("change", event => {
  const value = (event.target as HTMLSelectElement).value;
  const feature = value === "" ? undefined : osmData?.features[Number(value)];
  if (feature) inspectFeature(feature.properties);
});

function renderOsm() {
  osmLayers.clearLayers();
  if (!osmData) return;
  const enabled = new Set(Array.from(document.querySelectorAll<HTMLInputElement>(".layer-toggles input:checked"), i => i.value));
  // GeoJSON comes from the local API; Leaflet's geometry types are narrower than its runtime input.
  L.geoJSON(osmData as GeoJSON.GeoJsonObject, {
    pmIgnore: true,
    filter: feature => enabled.has(feature.properties.category),
    style: feature => { const kind = feature!.properties.category as keyof typeof colors; return { color: colors[kind], fillColor: colors[kind], weight: kind === "roads" ? 2 : 1, fillOpacity: 0.22, dashArray: kind === "boundaries" ? "5 4" : undefined }; },
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 3, color: colors[feature.properties.category as keyof typeof colors], weight: 1, fillOpacity: 0.65, pmIgnore: true }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties as FeatureCollection["features"][number]["properties"];
      layer.bindTooltip(tooltip(p.tags.name || `${p.osmType} ${p.osmId}`));
      layer.on("click", () => inspectFeature(p));
    },
  }).addTo(osmLayers);
  objects.bringToFront();
}
for (const input of document.querySelectorAll<HTMLInputElement>(".layer-toggles input")) input.addEventListener("change", renderOsm);
button("load-osm").addEventListener("click", async () => {
  if (selection.kind !== "area" || osmBusy) return;
  const area = world.areas[selection.id];
  if (!validBounds(area.bbox)) { notice("Set a valid area rectangle before loading OSM."); return; }
  clearOsm();
  const generation = osmGeneration;
  osmBusy = true;
  osmBounds = JSON.stringify(area.bbox);
  button("load-osm").disabled = true;
  button("load-osm").textContent = "Loading…";
  get("osm-status").textContent = `Fetching open data for ${area.title}…`;
  notice();
  try {
    const result = await api<FeatureCollection>("osm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bbox: area.bbox }) });
    if (generation !== osmGeneration || osmBounds !== JSON.stringify(area.bbox)) return;
    osmData = result;
    const choices = result.features.map((feature, index) => new Option(feature.properties.tags.name || `${feature.properties.osmType} ${feature.properties.osmId}`, String(index)));
    get<HTMLSelectElement>("feature-select").replaceChildren(new Option("Choose a feature…", ""), ...choices);
    get("feature-picker").hidden = !choices.length;
    renderOsm();
    get("osm-status").textContent = `${result.features.length.toLocaleString()} features loaded for ${area.title}. Click a feature to inspect its tags.`;
    get("map-hint").textContent = "Click an OSM feature to see its source tags.";
  } catch (error) {
    if (generation === osmGeneration) get("osm-status").textContent = String(error instanceof Error ? error.message : error);
  } finally {
    if (generation === osmGeneration) { osmBusy = false; button("load-osm").disabled = false; button("load-osm").textContent = "Load area OSM ↓"; }
  }
});

async function load() {
  notice();
  snapshot = await api<Snapshot>("world");
  world = structuredClone(snapshot.world);
  baseline = JSON.stringify(world);
  const initialRegion = world.cities[world.defaultCity].region;
  selection = { kind: "region", id: initialRegion };
  regionId = initialRegion;
  clearOsm();
  renderNavigation();
  renderProperties();
  renderMap();
  fitRegion();
  for (const id of ["new-region", "new-area", "new-city", "fit", "draw-area", "place-city"]) button(id).disabled = false;
  regionSelect.disabled = false;
  updateState();
  void buildPanel.refresh();
}
button("reload").addEventListener("click", async () => {
  if (dirty() && !confirm("Discard unsaved changes and reload the configuration from disk?")) return;
  try { await load(); } catch (e) { notice(`Could not reload: ${e instanceof Error ? e.message : e}`); }
});
button("save").addEventListener("click", async () => {
  if (buildActive) return;
  try {
    validateWorld(world);
    saving = true;
    updateState();
    document.querySelector<HTMLElement>("main")!.inert = true;
    const saved = await api<Snapshot>("world", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, revision: snapshot.revision }) });
    snapshot = saved;
    baseline = JSON.stringify(saved.world);
    notice();
    renderNavigation();
    renderProperties();
    renderMap();
  } catch (e) { notice(e instanceof Error ? e.message : String(e)); }
  finally { saving = false; document.querySelector<HTMLElement>("main")!.inert = false; updateState(); }
});

const buildPanel = setupBuildPanel(
  () => ({ area: selection?.kind === "area" ? selection.id : null, revision: snapshot?.revision ?? "", dirty: dirty(), ready: !!world }),
  active => {
    buildActive = active;
    updateState();
    form.inert = active;
    if (!world) return;
    cancelTool();
    renderMap();
    if (!active) {
      api<Snapshot>("world").then(current => {
        snapshot.locks = current.locks;
        renderNavigation(); renderProperties(); renderMap();
      }).catch(() => {});
    }
  },
);

new ResizeObserver(() => map.invalidateSize()).observe(get("map"));
load().catch(e => {
  get("save-state").textContent = "Connection failed";
  notice(`Could not open the local editor API: ${e instanceof Error ? e.message : e}. Start with npm run editor; the static build has no write API.`);
  button("reload").disabled = false;
});
