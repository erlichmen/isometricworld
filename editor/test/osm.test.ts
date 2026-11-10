import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertOsm, OsmService } from '../server/osm.ts';

const points = [{lat: 1, lon: 1}, {lat: 1, lon: 1.01}, {lat: 1.01, lon: 1.01}, {lat: 1, lon: 1}];
const response = (elements: unknown[]) => ({ version: 0.6, osm3s: { timestamp_osm_base: '2026-01-01' }, elements });
test('converts all categories with raw tags, coordinates and identifiers', () => {
  const result = convertOsm(response([
    { type: 'way', id: 1, tags: { building: 'yes', height: '12' }, geometry: points },
    { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: points.slice(0, 2) },
    { type: 'node', id: 3, lat: 1, lon: 2, tags: { natural: 'tree' } },
    { type: 'way', id: 4, tags: { natural: 'water' }, geometry: points },
    { type: 'relation', id: 5, tags: { boundary: 'administrative', type: 'boundary' }, members: [{type: 'way', ref: 9, role: 'outer', geometry: points.slice(0, 2)}] },
  ]));
  assert.deepEqual(result.features.map(f => f.properties.category), ['buildings', 'roads', 'trees', 'water', 'boundaries']);
  assert.equal(result.features[0].properties.tags.height, '12');
  assert.equal(result.features[0].properties.osmId, 1);
  assert.equal(result.features[0].geometry.type, 'Polygon');
  assert.deepEqual(result.features[2].geometry.coordinates, [2, 1]);
  assert.equal(result.features[4].geometry.type, 'MultiLineString');
});
test('joins reversed relation segments and resolves referenced nodes/ways', () => {
  const result = convertOsm(response([
    { type: 'node', id: 10, lat: 1, lon: 1 }, { type: 'node', id: 11, lat: 1, lon: 1.01 },
    { type: 'way', id: 12, nodes: [10, 11] },
    { type: 'relation', id: 13, tags: { natural: 'water', type: 'multipolygon' }, members: [
      { type: 'way', ref: 12, role: 'outer' },
      { type: 'way', ref: 14, role: 'outer', geometry: [points[0], points[2], points[1]] },
    ] },
  ]));
  assert.equal(result.features[0].geometry.type, 'MultiPolygon');
  assert.deepEqual(result.features[0].geometry.coordinates, [[[ [1, 1], [1.01, 1], [1.01, 1.01], [1, 1] ]]]);
});
test('rejects remarks, missing response envelope and incomplete geometry', () => {
  assert.throws(() => convertOsm({ ...response([]), remark: 'runtime error' }), /incomplete/);
  assert.throws(() => convertOsm({ elements: [] }), /incomplete/);
  assert.throws(() => convertOsm(response([{ type: 'way', id: 1, tags: { highway: 'road' }, nodes: [8, 9] }])), /incomplete/);
  assert.throws(() => convertOsm(response([{ type: 'relation', id: 1, tags: { natural: 'water' }, members: [{ type: 'way', ref: 2, role: 'outer', geometry: points.slice(0, 2) }] }])), /incomplete/);
});
test('linear river relations preserve open member ways as MultiLineString', () => {
  const result = convertOsm(response([
    { type: 'relation', id: 20, tags: { type: 'waterway', waterway: 'river', name: 'River' }, members: [
      { type: 'way', ref: 21, role: 'main_stream', geometry: points.slice(0, 2) },
      { type: 'way', ref: 22, role: 'side_stream', geometry: points.slice(1, 3) },
    ] },
  ]));
  assert.equal(result.features[0].properties.category, 'water');
  assert.equal(result.features[0].geometry.type, 'MultiLineString');
  assert.deepEqual(result.features[0].geometry.coordinates, [[[1, 1], [1.01, 1]], [[1.01, 1], [1.01, 1.01]]]);
});
test('bounds requests, caches completed responses and exposes upstream errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'editor-osm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const service = new OsmService({ root, fetch: (async (url, init) => {
    calls++; assert.equal(url, 'https://overpass-api.de/api/interpreter'); assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('User-Agent'), 'IsometricWorld/1.0 (open-data region editor)');
    assert.equal(headers.get('Accept'), 'application/json');
    return Response.json(response([]));
  }) as typeof fetch });
  assert.throws(() => service.load([0, 0, 1, 1]), /limited/);
  assert.throws(() => service.load([1, 1, 0, 0]), /bbox/);
  await Promise.all([service.load([1, 1, 1.01, 1.01]), service.load([1, 1, 1.01, 1.01])]);
  assert.equal(calls, 1);
  for (const fetcher of [
    async () => new Response('busy', { status: 429 }),
    async () => new Response('{"elements":['),
    async () => Response.json({ ...response([]), remark: 'timeout' }),
    async () => { throw new Error('network'); },
    async () => new Response('x'.repeat(20 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(new OsmService({ root, fetch: fetcher as typeof fetch }).load([2, 2, 2.01, 2.01]));
  }
});
