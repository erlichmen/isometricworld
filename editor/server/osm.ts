import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateBbox } from '../../shared/src/validate.ts';
import { EditorError, rootPath } from './store.ts';

type Point = [number, number];
type Element = { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; tags?: Record<string, string>; nodes?: number[]; geometry?: { lat: number; lon: number }[]; members?: { type: string; ref: number; role: string; geometry?: {lat: number; lon: number}[] }[] };
type Category = 'buildings' | 'roads' | 'trees' | 'water' | 'boundaries';
export interface FeatureCollection { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: { osmType: string; osmId: number; category: Category; tags: Record<string, string> } }[] }
const LIMIT = 20 * 1024 * 1024;
function fail(message: string): never { throw new EditorError(message, 502); }
function category(tags: Record<string, string>): Category | undefined {
  if (tags.building && tags.building !== 'no') return 'buildings';
  if (tags.highway) return 'roads';
  if (tags.natural === 'tree' || tags.natural === 'tree_row' || tags.landuse === 'forest' || tags.natural === 'wood') return 'trees';
  if (tags.natural === 'water' || tags.natural === 'coastline' || tags.water || tags.waterway) return 'water';
  if (tags.boundary) return 'boundaries';
}
function point(value: { lat?: number; lon?: number }): Point {
  if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon) || Math.abs(value.lat!) > 90 || Math.abs(value.lon!) > 180) fail('OSM response contains incomplete coordinates.');
  return [value.lon!, value.lat!];
}
const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
function rings(lines: Point[][]): Point[][] {
  const remaining = lines.map(line => [...line]);
  const result: Point[][] = [];
  while (remaining.length) {
    const ring = remaining.shift()!;
    while (!same(ring[0], ring.at(-1)!)) {
      const i = remaining.findIndex(line => same(ring.at(-1)!, line[0]) || same(ring.at(-1)!, line.at(-1)!));
      if (i < 0) fail('OSM relation has incomplete polygon geometry.');
      const line = remaining.splice(i, 1)[0];
      if (!same(ring.at(-1)!, line[0])) line.reverse();
      ring.push(...line.slice(1));
    }
    if (ring.length < 4) fail('OSM polygon is incomplete.');
    result.push(ring);
  }
  return result;
}
function contains(ring: Point[], [x, y]: Point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function convertOsm(value: unknown): FeatureCollection {
  const data = value as { elements?: Element[]; remark?: unknown; version?: number; osm3s?: unknown };
  if (!data || data.remark || data.version !== 0.6 || !data.osm3s || !Array.isArray(data.elements)) fail('Overpass returned an incomplete response or error remark.');
  const nodes = new Map<number, Element>(), ways = new Map<number, Element>();
  for (const e of data.elements) {
    if (!e || !Number.isSafeInteger(e.id) || !['node', 'way', 'relation'].includes(e.type)) fail('OSM response contains an invalid element.');
    if (e.type === 'node') nodes.set(e.id, e);
    if (e.type === 'way') ways.set(e.id, e);
  }
  const line = (e: Element): Point[] => {
    const result = e.geometry ? e.geometry.map(point) : e.nodes?.map(id => point(nodes.get(id) ?? {}));
    if (!result || result.length < 2 || (e.nodes && result.length !== e.nodes.length)) fail('OSM response contains incomplete way geometry.');
    return result;
  };
  const features: FeatureCollection['features'] = [];
  for (const e of data.elements) {
    const tags = e.tags ?? {};
    if (typeof tags !== 'object' || Object.values(tags).some(v => typeof v !== 'string')) fail('Invalid OSM tags.');
    const kind = category(tags);
    if (!kind) continue;
    let geometry: FeatureCollection['features'][number]['geometry'];
    if (e.type === 'node') geometry = { type: 'Point', coordinates: point(e) };
    else if (e.type === 'way') {
      const points = line(e);
      const polygon = kind !== 'roads' && kind !== 'boundaries' && tags.natural !== 'coastline' && same(points[0], points.at(-1)!) && points.length >= 4;
      geometry = { type: polygon ? 'Polygon' : 'LineString', coordinates: polygon ? [points] : points };
    } else {
      if (!Array.isArray(e.members) || !e.members.length) fail('OSM relation has no geometry.');
      const members = e.members.filter(m => m.type === 'way');
      if (!members.length) fail('OSM relation has no way geometry.');
      const lines = members.map(m => ({ role: m.role, points: m.geometry ? line({ type: 'way', id: m.ref, geometry: m.geometry }) : line(ways.get(m.ref) ?? { type: 'way', id: m.ref }) }));
      if (tags.type !== 'multipolygon' && (kind === 'boundaries' || kind === 'water' && tags.type === 'waterway')) geometry = { type: 'MultiLineString', coordinates: lines.map(l => l.points) };
      else {
        const outer = rings(lines.filter(l => l.role !== 'inner').map(l => l.points));
        if (!outer.length) fail('OSM relation has no outer polygon.');
        const polygons = outer.map(ring => [ring]);
        for (const hole of rings(lines.filter(l => l.role === 'inner').map(l => l.points))) {
          const i = outer.findIndex(ring => contains(ring, hole[0]));
          if (i < 0) fail('OSM relation has an unmatched inner polygon.');
          polygons[i].push(hole);
        }
        geometry = { type: 'MultiPolygon', coordinates: polygons };
      }
    }
    features.push({ type: 'Feature', geometry, properties: { osmType: e.type, osmId: e.id, category: kind, tags } });
  }
  return { type: 'FeatureCollection', features };
}

export class OsmService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: { root?: string; fetch?: typeof fetch } = {}) {}
  load(bbox: unknown): Promise<FeatureCollection> {
    validateBbox(bbox);
    if (bbox[2] - bbox[0] > 0.05 || bbox[3] - bbox[1] > 0.05) throw new EditorError('OSM inspection is limited to 0.05° in each direction. Select a smaller area.');
    const bounds = [...bbox];
    const task = this.queue.then(async () => {
      const query = `[out:json][timeout:25][maxsize:16777216];(nwr["building"](${bounds});way["highway"](${bounds});nwr["natural"~"^(tree|tree_row|wood|water|coastline)$"](${bounds});way["landuse"="forest"](${bounds});nwr["water"](${bounds});nwr["waterway"](${bounds});nwr["boundary"](${bounds}););out body geom;`;
      const directory = join(this.options.root ?? rootPath, 'data/raw/editor');
      const file = join(directory, `${createHash('sha256').update(query).digest('hex')}.json`);
      try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (Date.now() - cached.savedAt < 3600_000) return convertOsm(cached.data);
      } catch { /* Cache misses and invalid cached responses are fetched again. */ }
      try {
        const response = await (this.options.fetch ?? fetch)('https://overpass-api.de/api/interpreter', {
          method: 'POST', body: new URLSearchParams({ data: query }), redirect: 'error', signal: AbortSignal.timeout(35_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'IsometricWorld/1.0 (open-data region editor)' },
        });
        if (!response.ok) { await response.body?.cancel(); fail(`Overpass request failed (${response.status}). Try again later.`); }
        if (!response.body) fail('Overpass returned an empty response.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > LIMIT) { await reader.cancel(); fail('Overpass response exceeds 20 MiB. Select a smaller area.'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
        const result = convertOsm(data);
        await mkdir(directory, { recursive: true });
        await writeFile(file, JSON.stringify({ savedAt: Date.now(), data }));
        return result;
      } catch (error) {
        if (error instanceof EditorError) throw error;
        fail('OSM inspection failed or timed out. Try a smaller area or retry later.');
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
