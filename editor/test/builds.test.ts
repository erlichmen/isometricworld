import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { BuildManager, COPERNICUS_CREDIT, buildCamera, readBuildWorld, atomicJson, type BuildJob } from '../server/builds.ts';

const run = promisify(execFile);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'isometric-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const world = {
    regions: { sample: { title: 'Sample', origin: { lat: 32, lon: 34, h: 0 }, headingDeg: 30, country: 'Test', municipalities: [], credits: ['© OpenStreetMap contributors', 'Copernicus DEM © DLR, Airbus', 'Painted with AI'] } },
    areas: { sample: { title: 'Sample area', region: 'sample', bbox: [32, 34, 32.001, 34.001] as [number, number, number, number] } },
    cities: { sample: { title: 'Sample', region: 'sample', center: [32, 34] as [number, number], widthM: 1000 } }, defaultCity: 'sample',
  };
  for (const path of ['shared/src', 'pipeline/src', 'data/derived/sample/paint', 'data/web-state', 'data/web', 'web/public']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'shared/src/world.json'), JSON.stringify(world));
  await writeFile(join(root, '.env'), `CHROME_PATH=${process.execPath}\n`);
  const protectedFiles = ['data/derived/sample/paint/precious.png', 'data/web-state/precious.json', 'data/web/precious.bin', 'web/public/precious.bin', 'shared/src/world.json'];
  for (const file of protectedFiles.slice(0, -1)) await writeFile(join(root, file), 'preserve');
  const original = await Promise.all(protectedFiles.map(path => readFile(join(root, path))));
  const common = `import {appendFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const root=process.cwd();
const stage=import.meta.url.split('/').pop().replace('.ts','');
await appendFile(join(root,'order.log'),stage+'\\n');
console.log('fixture '+stage+' '+JSON.stringify(process.argv.slice(2)));
let mode=''; try {mode=await readFile(join(root,'mode'),'utf8')}catch{}
await new Promise(r=>setTimeout(r,100));
if(stage==='fetch'){await mkdir(join(root,'data/raw/sample'),{recursive:true});await writeFile(join(root,'data/raw/sample/cache.json'),'cached original bounds');}
if(mode==='fail-'+stage) throw new Error('fixture failed '+stage);
if(mode==='change-'+stage) await appendFile(join(root,'shared/src/world.json'),' ');
`;
  for (const stage of ['fetch', 'ground', 'scene']) await writeFile(join(root, 'pipeline/src', `${stage}.ts`), common);
  await writeFile(join(root, 'pipeline/src/render.ts'), common + `
const sharp=(await import(${JSON.stringify(import.meta.resolve('sharp'))})).default;
const world=JSON.parse(await readFile(join(root,'shared/src/world.json'),'utf8'));
const r=world.regions.sample;
const directory=join(root,'data/derived/sample');
for(const d of ['render','height'])await mkdir(join(directory,d),{recursive:true});
const camera={region:'sample',origin:r.origin,headingDeg:r.headingDeg,pitchDeg:45,mpp:0.25,tile:1024};
const tiles=mode==='zero'?[]:mode==='wide'?[{x:-1,y:2},{x:5,y:2}]:[{x:-1,y:2},{x:0,y:2}];
for(const {x,y} of tiles){
 if(mode==='missing'&&x===0)continue;
 const png=join(directory,'render',x+'_'+y+'.png');
 if(mode==='corrupt'&&x===0)await writeFile(png,'bad image');
 else await sharp({create:{width:1024,height:1024,channels:3,background:'#ff0000'}}).png().toFile(png);
 await sharp({create:{width:256,height:256,channels:3,background:'#000000'}}).png().toFile(join(directory,'height',x+'_'+y+'.png'));
}
await writeFile(join(directory,'manifest.json'),JSON.stringify({area:'sample',bbox:world.areas.sample.bbox,camera,tiles,attributions:['Fixture municipality']}));
`);
  const manager = new BuildManager(root), { revision } = await readBuildWorld(root);
  const unchanged = async () => { for (let i = 0; i < protectedFiles.length; i++) assert.deepEqual(await readFile(join(root, protectedFiles[i])), original[i], protectedFiles[i]); };
  return { root, world, manager, revision, unchanged };
}
async function finished(manager: BuildManager) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await manager.snapshot('sample');
    if (state.job && state.job.status !== 'running' && !state.active) return state.job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture build timed out');
}

test('detached build survives launching server exit, reattaches, orders stages and preserves protected files', async t => {
  const f = await fixture(t);
  const entry = `import {BuildManager} from ${JSON.stringify(new URL('../server/builds.ts', import.meta.url).href)}; const job=await new BuildManager(${JSON.stringify(f.root)}).start('sample',${JSON.stringify(f.revision)});console.log(JSON.stringify(job));`;
  const launched = await run(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', entry], { timeout: 5000 });
  const start: BuildJob = JSON.parse(launched.stdout);
  assert.equal(start.status, 'running');
  const reloaded = new BuildManager(f.root);
  assert.equal((await reloaded.snapshot('sample')).active?.id, start.id);
  await assert.rejects(reloaded.start('sample', f.revision), /Another build/);
  await assert.rejects(reloaded.withSaveLock(async () => 'write'), /Another build/);
  const job = await finished(reloaded);
  assert.equal(job.status, 'succeeded', job.log);
  assert.deepEqual(job.completedStages, ['fetch', 'ground', 'scene', 'render', 'preview']);
  assert.equal(await readFile(join(f.root, 'order.log'), 'utf8'), 'fetch\nground\nscene\nrender\n');
  assert.match(job.log, /fixture render \["sample","-j","2"\]/);
  assert.ok(job.credits.includes(COPERNICUS_CREDIT));
  assert.ok(job.credits.includes('Fixture municipality'));
  const metadata = await sharp(await reloaded.preview(job.id)).metadata();
  assert.equal(metadata.width, 2048); assert.equal(metadata.height, 1024);
  await assert.rejects(reloaded.preview('../bad'), /Invalid build/);
  await f.unchanged();
});

test('Vite SSR-loaded backend resolves the native worker and tsx loader', async t => {
  const f = await fixture(t), { createServer } = await import('vite');
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, cacheDir: join(f.root, '.vite'), server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  t.after(() => server.close());
  const module = await server.ssrLoadModule('/server/builds.ts');
  const manager = new module.BuildManager(f.root) as BuildManager;
  await manager.start('sample', f.revision);
  const job = await finished(manager);
  assert.equal(job.status, 'succeeded', job.log);
  await f.unchanged();
});

test('validation refuses stale revisions, unknown or oversized areas, stale cached camera and saves block builds', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.start('sample', 'old'), /changed on disk/);
  await assert.rejects(f.manager.start('../sample', f.revision), /Invalid area/);
  await assert.rejects(f.manager.start('unknown', f.revision), /Unknown saved/);
  await f.manager.withSaveLock(async () => {
    await assert.rejects(f.manager.start('sample', f.revision), /Another build/);
  });
  f.world.areas.sample.bbox[2] = 33;
  await writeFile(join(f.root, 'shared/src/world.json'), JSON.stringify(f.world));
  await assert.rejects(f.manager.start('sample', (await readBuildWorld(f.root)).revision), /0.25 degrees/);
  f.world.areas.sample.bbox[2] = 32.001;
  await writeFile(join(f.root, 'shared/src/world.json'), JSON.stringify(f.world));
  await writeFile(join(f.root, 'data/derived/sample/manifest.json'), JSON.stringify({ area: 'sample', bbox: f.world.areas.sample.bbox, camera: { ...buildCamera(f.world, 'sample'), headingDeg: 31 }, tiles: [] }));
  await assert.rejects(f.manager.start('sample', f.revision), /bounds or camera differ/);
  await writeFile(join(f.root, 'data/derived/sample/manifest.json'), JSON.stringify({ area: 'sample', bbox: [0, 0, 1, 1], camera: buildCamera(f.world, 'sample'), tiles: [] }));
  await assert.rejects(f.manager.start('sample', f.revision), /bounds or camera differ/);
});

test('simultaneous managers admit one build and cap preview dimensions at 4096 pixels', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'mode'), 'wide');
  const attempts = await Promise.allSettled([f.manager.start('sample', f.revision), new BuildManager(f.root).start('sample', f.revision)]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(a => a.status === 'rejected').length, 1);
  const job = await finished(f.manager);
  assert.equal(job.status, 'succeeded', job.log);
  const image = await sharp(await f.manager.preview(job.id)).metadata();
  assert.equal(image.width, 4096); assert.ok(image.height! <= 4096);
  await f.unchanged();
});

test('a status request beginning before start cannot interrupt the newly published job', async t => {
  const f = await fixture(t);
  const internal = f.manager as unknown as { active: () => Promise<BuildJob | null> };
  const original = internal.active.bind(f.manager);
  let resume!: () => void, observed!: () => void, first = true;
  const read = new Promise<void>(resolve => { observed = resolve; });
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  internal.active = async () => {
    const result = await original();
    if (first) { first = false; observed(); await barrier; }
    return result;
  };
  const polling = f.manager.snapshot('sample');
  await read;
  const started = await new BuildManager(f.root).start('sample', f.revision);
  resume();
  const state = await polling;
  assert.equal(state.active?.id, started.id);
  assert.equal(state.job?.status, 'running');
  assert.equal((await finished(f.manager)).status, 'succeeded');
});

test('interrupted worker retains disk ownership while its process group can still write', async t => {
  const f = await fixture(t), id = '12345678-1234-4234-8234-123456789abc';
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { detached: true, stdio: 'ignore' });
  const exit = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  child.unref();
  await mkdir(f.manager.jobDirectory(id), { recursive: true });
  await f.manager.writeJob({ id, area: 'sample', region: 'sample', title: 'Sample', status: 'running', stage: 'fetch', completedStages: [], startedAt: new Date(0).toISOString(), log: '', credits: [] });
  await mkdir(join(f.root, 'data/editor/build.lock'));
  await writeFile(join(f.root, 'data/editor/build.lock/dead'), '');
  await atomicJson(f.manager.lockPath, { id, token: 'dead', pid: 2147483647, groupPid: child.pid });
  const state = await f.manager.snapshot('sample');
  assert.equal(state.active?.status, 'interrupted');
  assert.match(state.active?.message ?? '', /still running/);
  await assert.rejects(f.manager.start('sample', f.revision), /Another build/);
  await assert.rejects(f.manager.withSaveLock(async () => {}), /Another build/);
  await exit;
  assert.equal((await f.manager.snapshot('sample')).active, null);
  await writeFile(join(f.manager.jobDirectory(id), 'output.log'), 'x'.repeat(100000));
  assert.equal((await f.manager.snapshot('sample')).job?.log.length, 64 * 1024);
});

test('failed stages retain logs and allow a fresh retry', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'mode'), 'fail-ground');
  await f.manager.start('sample', f.revision);
  const failed = await finished(f.manager);
  assert.equal(failed.status, 'failed'); assert.equal(failed.stage, 'ground');
  assert.match(failed.log, /fixture failed ground/);
  assert.deepEqual(failed.completedStages, ['fetch']);
  await assert.rejects(f.manager.preview(failed.id), /completed preview/);
  await writeFile(join(f.root, 'mode'), '');
  const retry = await f.manager.start('sample', f.revision);
  assert.notEqual(retry.id, failed.id);
  assert.equal((await finished(f.manager)).status, 'succeeded');
  await f.unchanged();
});

for (const mode of ['missing', 'corrupt', 'zero']) test(`successful render exit with ${mode} output fails preview validation`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'mode'), mode);
  await f.manager.start('sample', f.revision);
  const job = await finished(f.manager);
  assert.equal(job.status, 'failed'); assert.equal(job.stage, 'preview');
  assert.match(job.message!, mode === 'zero' ? /no tiles/ : /missing or corrupt/);
  await assert.rejects(f.manager.preview(job.id), /completed preview/);
  await f.unchanged();
});

test('revision changes during a stage stop following stages', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'mode'), 'change-fetch');
  await f.manager.start('sample', f.revision);
  const job = await finished(f.manager);
  assert.equal(job.status, 'failed'); assert.match(job.message!, /Configuration changed/);
  assert.equal(await readFile(join(f.root, 'order.log'), 'utf8'), 'fetch\n');
});

test('failed pre-manifest builds cannot reuse raw data after changing bounds; legacy raw caches need provenance', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'mode'), 'fail-ground');
  await f.manager.start('sample', f.revision);
  assert.equal((await finished(f.manager)).status, 'failed');
  const cache = join(f.root, 'data/raw/sample/cache.json'), before = await readFile(cache);
  f.world.areas.sample.bbox[2] = 32.002;
  await writeFile(join(f.root, 'shared/src/world.json'), JSON.stringify(f.world));
  await assert.rejects(f.manager.start('sample', (await readBuildWorld(f.root)).revision), /Cached raw data.*new area identifier/);
  assert.deepEqual(await readFile(cache), before);
  const legacy = await fixture(t);
  await mkdir(join(legacy.root, 'data/raw/sample'), { recursive: true });
  await writeFile(join(legacy.root, 'data/raw/sample/cache.json'), 'legacy cache');
  await assert.rejects(legacy.manager.start('sample', legacy.revision), /Cached raw data.*unverified/);
  assert.equal(await readFile(join(legacy.root, 'data/raw/sample/cache.json'), 'utf8'), 'legacy cache');
});

test('dead disk owners become interrupted and permit retry without signaling any process', async t => {
  const f = await fixture(t);
  const id = '12345678-1234-4234-8234-123456789abc';
  await mkdir(f.manager.jobDirectory(id), { recursive: true });
  await f.manager.writeJob({ id, area: 'sample', region: 'sample', title: 'Sample', status: 'running', stage: 'fetch', completedStages: [], startedAt: new Date(0).toISOString(), log: '', credits: [] });
  await mkdir(join(f.root, 'data/editor/build.lock'));
  await writeFile(join(f.root, 'data/editor/build.lock/dead'), '');
  await atomicJson(f.manager.lockPath, { id, token: 'dead', pid: 2147483647 });
  const state = await f.manager.snapshot('sample');
  assert.equal(state.active, null); assert.equal(state.job?.status, 'interrupted');
  await assert.rejects(access(f.manager.lockPath));
  await f.manager.start('sample', f.revision);
  assert.equal((await finished(f.manager)).status, 'succeeded');
});
