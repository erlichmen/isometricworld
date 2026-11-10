import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scheduler } from "node:timers/promises";
import { validateBbox } from "../../shared/src/validate.ts";

type Bbox = [number, number, number, number];
type OsmElement = { type: "node" | "way" | "relation"; id: number; [key: string]: unknown };
type OsmData = { elements: OsmElement[]; [key: string]: unknown };
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

function checked(value: unknown): OsmData {
  const data = value as OsmData | null;
  if (!data || typeof data !== "object" || data.remark || !Array.isArray(data.elements)
    || data.elements.some(e => !e || !["node", "way", "relation"].includes(e.type) || !Number.isSafeInteger(e.id) || e.id < 1)) {
    throw new Error(`Incomplete OSM response${data?.remark ? `: ${String(data.remark).slice(0, 200)}` : ""}`);
  }
  return data;
}

function saveJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { flag: "wx" }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

async function readResponse(response: Response) {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("OSM response exceeds 32 MiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return checked(JSON.parse(Buffer.concat(chunks).toString()));
}

/** Fetch sequential small patches, retaining complete geometry and resumable parts. */
export async function fetchOsm(bbox: Bbox, selectors: (box: string) => string, file: string, label: string): Promise<OsmData> {
  validateBbox(bbox);
  const [s, w, n, e] = bbox;
  const rows = Math.ceil((n - s) / 0.02), columns = Math.ceil((e - w) / 0.02);
  if (rows * columns > 256) throw new Error("OSM area is too large. Split it into smaller areas before fetching.");
  let preferred = 0;
  async function request(query: string) {
    const errors: string[] = [];
    for (let attempt = 0; attempt < SERVERS.length * 2; attempt++) {
      if (attempt === SERVERS.length) { console.warn("  overpass: retrying public servers in 5 seconds…"); await scheduler.wait(5000); }
      const index = (preferred + attempt) % SERVERS.length, endpoint = SERVERS[index];
      try {
        const response = await fetch(endpoint, {
          method: "POST", body: new URLSearchParams({ data: query }), redirect: "error", signal: AbortSignal.timeout(45_000),
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "isometric-world/0.3 (+https://github.com/erlichmen/isometricworld; open-data map)" },
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const data = await readResponse(response);
        preferred = index;
        return data;
      } catch (error) {
        const message = `${new URL(endpoint).hostname}: ${error instanceof Error ? error.message : error}`;
        errors.push(message);
        console.warn(`  overpass ${message}${attempt + 1 < SERVERS.length * 2 ? "; trying the other public server" : ""}`);
      }
    }
    throw new Error(`OSM ${label} download failed (${errors.join("; ")}). Completed parts are cached; retry to resume.`);
  }

  const elements = new Map<string, OsmElement>();
  let first: OsmData | undefined;
  let part = 0;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const bounds = [s + (n - s) * row / rows, w + (e - w) * column / columns, s + (n - s) * (row + 1) / rows, w + (e - w) * (column + 1) / columns];
    const box = `(${bounds.map(v => v.toFixed(10)).join(",")})`;
    const query = `[out:json][timeout:25][maxsize:67108864];\n(${selectors(box)});\nout body geom;`;
    const cached = join(dirname(file), "overpass", `${createHash("sha256").update(query).digest("hex")}.json`);
    let data: OsmData | undefined;
    if (existsSync(cached)) {
      try { data = checked(JSON.parse(readFileSync(cached, "utf8"))); }
      catch { /* Re-fetch an incomplete part; keep completed parts intact. */ }
    }
    const reused = !!data;
    if (!data) {
      console.log(`  ${label}: fetching OSM part ${part + 1}/${rows * columns} ${box}`);
      data = await request(query);
      saveJson(cached, data);
    }
    first ??= data;
    for (const element of data.elements) elements.set(`${element.type}/${element.id}`, element);
    console.log(`  ${label}: OSM part ${++part}/${rows * columns}${reused ? " (cached)" : ""}, ${elements.size} elements`);
  }
  const result = { ...first, elements: [...elements.values()] };
  saveJson(file, result);
  return result;
}
