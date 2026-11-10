import type { IncomingMessage, ServerResponse } from 'node:http';
import { EditorError, WorldStore } from './store.ts';
import { OsmService } from './osm.ts';
import { PlaceSearch } from './search.ts';
import { BUILD_ID, BuildManager } from './builds.ts';
import { streamBuilds } from './build-events.ts';

const LIMIT = 1024 * 1024;
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new EditorError('Content-Type must be application/json');
  if (Number(req.headers['content-length']) > LIMIT) { req.resume(); throw new EditorError('Request exceeds 1 MiB', 413); }
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    let length = 0, exceeded = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (exceeded) return;
      if (length > LIMIT) { exceeded = true; reject(new EditorError('Request exceeds 1 MiB', 413)); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(chunks));
    req.on('error', reject);
    req.on('aborted', () => reject(new EditorError('Request body was interrupted')));
  });
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new EditorError('Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EditorError('Expected a JSON object');
  return value as Record<string, unknown>;
}
function shape(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).length !== fields.length || !fields.every(f => Object.hasOwn(value, f))) throw new EditorError('Unexpected request fields');
}
export function createApi(options: { store?: WorldStore; osm?: OsmService; search?: PlaceSearch; builds?: BuildManager } = {}) {
  const store = options.store ?? new WorldStore(), osm = options.osm ?? new OsmService();
  const search = options.search ?? new PlaceSearch();
  const builds = options.builds ?? new BuildManager();
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/editor/')) { next(); return; }
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      const port = req.socket.localPort;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) throw new EditorError('Loopback connection required', 403);
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!port || !allowed.includes(req.headers.host ?? '')) throw new EditorError('Loopback Host required', 403);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new EditorError('Same-origin request required', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new EditorError('Same-origin request required', 403);
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new EditorError('Same-origin Origin required', 403);
      if (path === '/api/editor/world' && req.method === 'GET') { send(200, await store.snapshot()); return; }
      if (path === '/api/editor/world' && req.method === 'PUT') {
        const value = await body(req); shape(value, ['world', 'revision']);
        send(200, await builds.withSaveLock(() => store.save(value.world, value.revision))); return;
      }
      if ((path === '/api/editor/builds' || path === '/api/editor/builds/events') && req.method === 'GET') {
        const query = new URL(req.url!, origin).searchParams;
        if ([...query.keys()].some(key => key !== 'area') || query.getAll('area').length > 1) throw new EditorError('Unexpected build query fields');
        const area = query.get('area') ?? undefined;
        if (path.endsWith('/events')) await streamBuilds(res, builds, area);
        else send(200, await builds.snapshot(area));
        return;
      }
      if (path === '/api/editor/builds' && req.method === 'POST') {
        const value = await body(req); shape(value, ['area', 'revision']);
        send(202, await builds.start(value.area, value.revision)); return;
      }
      const preview = /^\/api\/editor\/builds\/([^/]+)\/preview\.webp$/.exec(path);
      if (preview && req.method === 'GET') {
        if (!BUILD_ID.test(preview[1]) || req.url!.includes('?')) throw new EditorError('Invalid preview URL');
        const image = await builds.preview(preview[1]);
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': image.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(image); return;
      }
      if (path === '/api/editor/osm' && req.method === 'POST') {
        const value = await body(req); shape(value, ['bbox']);
        send(200, await osm.load(value.bbox)); return;
      }
      if (path === '/api/editor/search' && req.method === 'POST') {
        const value = await body(req); shape(value, ['query']);
        send(200, await search.search(value.query)); return;
      }
      send(404, { error: 'Unknown editor API route or method' });
    } catch (error) {
      send(error instanceof EditorError ? error.status : error instanceof Error && /^(world|regions|cities|areas|defaultCity|bbox|revision)/.test(error.message) ? 400 : 500,
        { error: error instanceof EditorError || error instanceof Error && /^(world|regions|cities|areas|defaultCity|bbox|revision)/.test(error.message) ? error.message : 'Editor operation failed; configuration was not changed.' });
    }
  };
}

export const editorApi = createApi();
