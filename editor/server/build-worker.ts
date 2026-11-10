import { spawn } from 'node:child_process';
import { access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { atomicJson, buildGroupAlive, BuildManager, checkManifest, readBuildWorld, readJson, type BuildInput, type BuildStage } from './builds.ts';

const [root, id] = process.argv.slice(2);
const manager = new BuildManager(root), directory = manager.jobDirectory(id);
const input = await readJson<BuildInput>(join(directory, 'input.json'));
let job = await manager.readJob(id);
const log = async (message: string) => { await appendFile(join(directory, 'output.log'), `${new Date().toISOString()} ${message}\n`); };
async function revision() {
  if ((await readBuildWorld(root)).revision !== input.revision) throw new Error('Configuration changed during the build. Reload and retry.');
}
async function preview() {
  const manifest = (await checkManifest(root, job.area, input, true))!;
  const tiles = manifest.tiles;
  if (!Array.isArray(tiles) || !tiles.length) throw new Error('Render produced no tiles. Draw a larger area and retry.');
  if (tiles.length > 100000 || tiles.some(t => !t || !Number.isSafeInteger(t.x) || !Number.isSafeInteger(t.y) || Math.abs(t.x) > 10000000 || Math.abs(t.y) > 10000000) || new Set(tiles.map(t => `${t.x}_${t.y}`)).size !== tiles.length) throw new Error('Render manifest has invalid tile coordinates.');
  const xs = tiles.map(t => t.x), ys = tiles.map(t => t.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), columns = Math.max(...xs) - minX + 1, rows = Math.max(...ys) - minY + 1;
  const scale = Math.min(1024, 4096 / Math.max(columns, rows));
  const width = Math.max(1, Math.round(columns * scale)), height = Math.max(1, Math.round(rows * scale));
  const images: OverlayOptions[] = [];
  for (const { x, y } of tiles) {
    const name = `${x}_${y}.png`, source = join(root, 'data/derived', job.area);
    try {
      const color = sharp(join(source, 'render', name), { failOn: 'warning' });
      const metadata = await color.metadata();
      if (metadata.width !== 1024 || metadata.height !== 1024) throw new Error('Expected a 1024 × 1024 render');
      const elevation = sharp(join(source, 'height', name), { failOn: 'warning' });
      const h = await elevation.metadata();
      if (h.width !== 256 || h.height !== 256) throw new Error('Expected a 256 × 256 height pass');
      await elevation.raw().toBuffer();
      const left = Math.round((x - minX) * scale), top = Math.round((y - minY) * scale);
      images.push({ input: await color.resize(Math.max(1, Math.round((x - minX + 1) * scale) - left), Math.max(1, Math.round((y - minY + 1) * scale) - top)).png().toBuffer(), left, top });
    } catch (error) { throw new Error(`Render tile ${name} is missing or corrupt: ${(error as Error).message}`); }
  }
  await sharp({ create: { width, height, channels: 3, background: '#e5e1d7' } }).composite(images).webp({ quality: 88 }).toFile(join(directory, 'preview.webp'));
  job.credits = [...new Set([...job.credits, ...(Array.isArray(manifest.attributions) ? manifest.attributions.filter((s): s is string => typeof s === 'string') : [])])];
  await atomicJson(join(directory, 'preview.json'), { label: 'Raw render', width, height, credits: job.credits, sourceManifest: `${job.area}/manifest.json` });
}

let token: string | undefined;
try {
  // The parent publishes our PID before releasing this startup barrier.
  for (let i = 0; ; i++) {
    try { await access(join(directory, 'ready')); break; }
    catch { if (i >= 100) throw new Error('Build startup was interrupted.'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  const lock = await readJson<{ id: string; token: string; pid: number; childPid?: number }>(manager.lockPath);
  if (lock.id !== id || lock.pid !== process.pid) throw new Error('Build ownership was lost.');
  token = lock.token;
  for (const stage of ['fetch', 'ground', 'scene', 'render', 'preview'] as BuildStage[]) {
    await revision();
    job.stage = stage; await manager.writeJob(job); await log(`Starting ${stage}`);
    if (stage === 'preview') await preview();
    else {
      const child = spawn(process.execPath, ['--import', input.loader, fileURLToPath(new URL('./build-stage.ts', import.meta.url)), root, id, stage], { cwd: root, detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CHROME_PATH: input.chrome } });
      const completion = new Promise<Error | null>(resolve => {
        child.once('error', resolve);
        child.once('exit', (code, signal) => resolve(code === 0 ? null : new Error(`${stage} failed (${signal ?? `exit ${code}`}). Check the build log.`)));
      });
      // Keep the stage PID on disk if this worker is interrupted.
      lock.childPid = child.pid;
      try {
        await atomicJson(manager.lockPath, lock);
        await appendFile(join(directory, `${stage}.ready`), '');
        const failure = await completion;
        if (failure) throw failure;
      } finally {
        // A failed lock write or exited CLI must not release live descendant writers.
        await completion;
        while (buildGroupAlive(child.pid)) await new Promise(resolve => setTimeout(resolve, 100));
        delete lock.childPid; await atomicJson(manager.lockPath, lock);
      }
    }
    await revision();
    job.completedStages.push(stage); await manager.writeJob(job); await log(`Completed ${stage}`);
  }
  job.status = 'succeeded'; job.previewUrl = `/api/editor/builds/${id}/preview.webp`;
} catch (error) {
  job.status = 'failed'; job.message = error instanceof Error ? error.message : 'Build failed'; await log(job.message);
} finally {
  job.finishedAt = new Date().toISOString(); await manager.writeJob(job);
  if (token) await manager.release(token);
}
