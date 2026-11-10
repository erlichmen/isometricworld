import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApi } from '../server/api.ts';
import type { WorldStore } from '../server/store.ts';
import type { OsmService } from '../server/osm.ts';
import type { PlaceSearch } from '../server/search.ts';
import type { BuildManager } from '../server/builds.ts';
import { EditorError } from '../server/store.ts';

test('API requires loopback connections/Host, same-origin JSON writes and bounded exact shapes', async () => {
  let writes = 0;
  const handler = createApi({
    store: { snapshot: async () => ({ world: {}, revision: 'abc', locks: {} }), save: async () => { writes++; return { revision: 'new' }; } } as unknown as WorldStore,
    osm: { load: async () => ({ type: 'FeatureCollection', features: [] }) } as unknown as OsmService,
    search: { search: async (query: unknown) => [{ label: query, lat: 32.794, lon: 34.9896 }] } as unknown as PlaceSearch,
    builds: { withSaveLock: async (save: () => Promise<unknown>) => save() } as unknown as BuildManager,
  });
  async function request(method = 'GET', body = '', headers: Record<string, string> = {}, url = '/api/editor/world', remoteAddress = '127.0.0.1') {
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      method, url, headers: { host: '127.0.0.1:4322', ...headers }, socket: { localPort: 4322, remoteAddress },
    }) as unknown as IncomingMessage;
    let status = 0, response = '';
    const res = { writeHead: (code: number) => { status = code; }, end: (value: string) => { response = value; } } as unknown as ServerResponse;
    await handler(req, res, () => { status = 404; });
    return { status, response };
  }
  const put = (body: string, headers = {}) => request('PUT', body, { origin: 'http://127.0.0.1:4322', 'content-type': 'application/json', ...headers });
  assert.equal((await request()).status, 200);
  assert.equal((await request('GET', '', {}, '/api/editor/world', '192.168.1.2')).status, 403);
  assert.equal((await request('GET', '', { host: 'evil.example' })).status, 403);
  assert.equal((await request('GET', '', { host: '127.0.0.1:1' })).status, 403);
  assert.equal((await request('GET', '', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('PUT', '{}')).status, 403);
  assert.equal((await put('{}', { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await put('{')).status, 400);
  assert.equal((await put('{"world":{},"revision":"abc","path":"/tmp/x"}')).status, 400);
  assert.equal((await put('x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await put('{}', { 'content-length': String(1024 * 1024 + 1) })).status, 413);
  assert.equal(writes, 0);
  assert.equal((await put('{"world":{},"revision":"abc"}')).status, 200);
  assert.equal(writes, 1);
  assert.equal((await request('POST', '{"bbox":[1,1,1.01,1.01]}', { origin: 'http://127.0.0.1:4322', 'content-type': 'application/json' }, '/api/editor/osm')).status, 200);
  assert.equal((await request('GET', '', {}, '/api/editor/unknown')).status, 404);
  const searchHeaders = { origin: 'http://127.0.0.1:4322', 'content-type': 'application/json' };
  const search = await request('POST', '{"query":"Haifa"}', searchHeaders, '/api/editor/search');
  assert.equal(search.status, 200);
  assert.deepEqual(JSON.parse(search.response), [{ label: 'Haifa', lat: 32.794, lon: 34.9896 }]);
  assert.equal((await request('POST', '{"query":"Haifa","url":"https://evil.example"}', searchHeaders, '/api/editor/search')).status, 400);
});

test('build routes validate queries and shapes, protect saves, and serve only fixed preview URLs', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  let blocked = false, writes = 0, starts = 0;
  const handler = createApi({
    store: { save: async () => { writes++; return {}; } } as unknown as WorldStore,
    builds: {
      snapshot: async (area?: string) => ({ active: null, job: area ? { id, area } : null }),
      start: async (area: unknown, revision: unknown) => {
        if (area !== 'sample' || revision !== 'saved') throw new EditorError('Unknown area or stale revision', 409);
        starts++; return { id, area, status: 'running' };
      },
      withSaveLock: async (save: () => Promise<unknown>) => { if (blocked) throw new EditorError('Another build is active', 409); return save(); },
      preview: async (value: string) => { assert.equal(value, id); return Buffer.from('image bytes'); },
    } as unknown as BuildManager,
  });
  async function request(method: string, url: string, value?: unknown, origin = 'http://127.0.0.1:4322') {
    const req = Object.assign(Readable.from([Buffer.from(value === undefined ? '' : JSON.stringify(value))]), {
      method, url, headers: { host: '127.0.0.1:4322', origin, 'content-type': 'application/json' }, socket: { localPort: 4322, remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    let status = 0, data: string | Buffer = '', headers: Record<string, unknown> = {};
    const res = { writeHead: (code: number, h: Record<string, unknown>) => { status = code; headers = h; }, end: (value: string | Buffer) => { data = value; } } as unknown as ServerResponse;
    await handler(req, res, () => {});
    return { status, data, headers };
  }
  assert.deepEqual(JSON.parse(String((await request('GET', '/api/editor/builds?area=sample')).data)), { active: null, job: { id, area: 'sample' } });
  assert.equal((await request('GET', '/api/editor/builds?area=sample&area=other')).status, 400);
  assert.equal((await request('GET', '/api/editor/builds?path=/tmp/private')).status, 400);
  assert.equal((await request('GET', '/api/editor/builds/events?area=sample&area=other')).status, 400);
  assert.equal((await request('GET', '/api/editor/builds/events?path=/tmp/private')).status, 400);
  assert.equal((await request('GET', '/api/editor/builds/events', undefined, 'https://evil.example')).status, 403);
  assert.equal((await request('POST', '/api/editor/builds', { area: 'sample', revision: 'saved', command: 'publish' })).status, 400);
  assert.equal((await request('POST', '/api/editor/builds', { area: 'sample', revision: 'old' })).status, 409);
  assert.equal((await request('POST', '/api/editor/builds', { area: 'sample', revision: 'saved' }, 'https://evil.example')).status, 403);
  assert.equal(starts, 0);
  assert.equal((await request('POST', '/api/editor/builds', { area: 'sample', revision: 'saved' })).status, 202);
  assert.equal(starts, 1);
  blocked = true;
  assert.equal((await request('PUT', '/api/editor/world', { world: {}, revision: 'saved' })).status, 409);
  assert.equal(writes, 0);
  const image = await request('GET', `/api/editor/builds/${id}/preview.webp`);
  assert.equal(image.status, 200); assert.equal(image.headers['Content-Type'], 'image/webp'); assert.deepEqual(image.data, Buffer.from('image bytes'));
  assert.equal((await request('GET', `/api/editor/builds/${id}/preview.webp?path=/tmp/private`)).status, 400);
  assert.equal((await request('GET', '/api/editor/builds/%2e%2e/preview.webp')).status, 400);
});
