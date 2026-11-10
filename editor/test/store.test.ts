import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldStore } from '../server/store.ts';
import { WORLD } from '../../shared/src/index.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'editor-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'shared/src'), { recursive: true });
  const world = structuredClone(WORLD);
  world.regions['new-region'] = structuredClone(world.regions['israel-center']);
  world.areas['new-area'] = { title: 'New', region: 'new-region', bbox: [1, 1, 1.01, 1.01] };
  const file = join(root, 'shared/src/world.json');
  await writeFile(file, JSON.stringify(world));
  const options = { root, tilesOrigin: 'https://tiles.example', fetch: (async () => new Response(null, { status: 404 })) as typeof fetch };
  return { root, file, world, options, store: new WorldStore(options) };
}

test('snapshots read fresh bytes; concurrent saves permit only one revision', async t => {
  const { store, file } = await fixture(t);
  const a = await store.snapshot(), b = structuredClone(a.world);
  b.regions['new-region'].title = 'Changed';
  const results = await Promise.allSettled([store.save(b, a.revision), store.save(b, a.revision)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejection = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejection.reason.status, 409);
  assert.equal((await store.snapshot()).world.regions['new-region'].title, 'Changed');
  await writeFile(file, JSON.stringify(a.world));
  assert.equal((await store.snapshot()).revision, a.revision);
});

test('invalid documents, removal, region reassignment and fixed camera edits preserve bytes', async t => {
  const { store, file } = await fixture(t);
  const snapshot = await store.snapshot(), before = await readFile(file, 'utf8');
  const mutations = [
    (w: typeof WORLD) => { w.areas['new-area'].bbox = [2, 1, 1, 2]; },
    (w: typeof WORLD) => { delete w.areas['new-area']; },
    (w: typeof WORLD) => { w.areas['new-area'].region = 'israel-center'; },
    (w: typeof WORLD) => { w.regions['israel-center'].origin.lat += 1; },
    (w: typeof WORLD) => { w.regions['israel-center'].headingDeg += 1; },
  ];
  for (const mutate of mutations) {
    const world = structuredClone(snapshot.world); mutate(world);
    await assert.rejects(store.save(world, snapshot.revision));
    assert.equal(await readFile(file, 'utf8'), before);
  }
});

test('local derived, export and published state lock cameras at save time', async t => {
  for (const artifact of ['data/derived/new-area', 'data/web/regions/new-region', 'data/web-state/new-region.json']) {
    const { root, store } = await fixture(t);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.locks['new-region'], undefined);
    if (artifact.endsWith('.json')) { await mkdir(join(root, 'data/web-state'), { recursive: true }); await writeFile(join(root, artifact), '{}'); }
    else await mkdir(join(root, artifact), { recursive: true });
    snapshot.world.regions['new-region'].headingDeg += 1;
    await assert.rejects(store.save(snapshot.world, snapshot.revision), /camera is locked/);
  }
});

test('existing municipal and other source credit lines must be retained verbatim', async t => {
  const { store, file } = await fixture(t);
  const snapshot = await store.snapshot(), before = await readFile(file, 'utf8');
  const region = snapshot.world.regions['israel-center'];
  assert.ok(region.credits.some(line => line.includes('Tel Aviv')));
  region.credits = region.credits.map(line => line.replace(/Tel Aviv[^·]*Municipality/g, ''));
  await assert.rejects(store.save(snapshot.world, snapshot.revision), /preserve existing source credits/);
  assert.equal(await readFile(file, 'utf8'), before);
  const valid = await store.snapshot();
  valid.world.regions['israel-center'].credits = valid.world.regions['israel-center'].credits.map(line => `${line} · Extra credit`);
  await store.save(valid.world, valid.revision);
});

test('production state handles existence, uncertainty and HEAD fallback', async t => {
  const { options, world } = await fixture(t);
  for (const status of [200, 403, 500]) {
    const store = new WorldStore({ ...options, fetch: (async () => new Response(null, { status })) as typeof fetch });
    assert.ok((await store.locks(world))['new-region']);
  }
  const methods: string[] = [];
  const store = new WorldStore({ ...options, fetch: (async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return new Response(null, { status: init?.method === 'HEAD' ? 405 : 404 });
  }) as typeof fetch });
  assert.equal((await store.locks(world))['new-region'], undefined);
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.ok((await new WorldStore({ ...options, fetch: (async () => { throw new Error('offline'); }) as typeof fetch }).locks(world))['new-region']);
});

test('production locks probe the published data/world.json path before allowing camera changes', async t => {
  const { options, world } = await fixture(t);
  const requested: string[] = [];
  const store = new WorldStore({ ...options, fetch: (async url => {
    requested.push(String(url));
    return new Response(null, { status: new URL(String(url)).pathname === '/regions/new-region/data/world.json' ? 200 : 404 });
  }) as typeof fetch });
  assert.match((await store.locks(world))['new-region'], /Production map metadata exists/);
  assert.deepEqual(requested, ['https://tiles.example/regions/new-region/data/world.json']);
  const snapshot = await store.snapshot();
  snapshot.world.regions['new-region'].headingDeg += 1;
  await assert.rejects(store.save(snapshot.world, snapshot.revision), /camera is locked/);
});

test('atomic replacement failures leave original intact and remove temporary files', async t => {
  const { options, file } = await fixture(t);
  const store = new WorldStore({ ...options, rename: async () => { throw new Error('simulated rename failure'); } });
  const snapshot = await store.snapshot(), before = await readFile(file, 'utf8');
  snapshot.world.regions['new-region'].title = 'Changed';
  await assert.rejects(store.save(snapshot.world, snapshot.revision), /rename failure/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(join(options.root, 'shared/src')), ['world.json']);
});
