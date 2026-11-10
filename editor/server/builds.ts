import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import type { Area, World } from '../../shared/src/index.ts';
import { validateWorld } from '../../shared/src/validate.ts';
import { EditorError, rootPath } from './store.ts';

export type BuildStage = 'fetch' | 'ground' | 'scene' | 'render' | 'preview';
export type BuildJob = {
  id: string; area: string; region: string; title: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: BuildStage; completedStages: BuildStage[];
  startedAt: string; finishedAt?: string; message?: string;
  log: string; previewUrl?: string; credits: string[];
};
export type BuildSnapshot = { active: BuildJob | null; job: BuildJob | null };
export const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const COPERNICUS_CREDIT = 'Copernicus DEM: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';
export type BuildInput = { root: string; revision: string; area: Area; camera: object; chrome: string; loader: string };
type Lock = { id: string | null; token: string; pid: number; childPid?: number; groupPid?: number };

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJson<T>(path: string): Promise<T | null> {
  try { return await readJson<T>(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function readBuildWorld(root: string) {
  const bytes = await readFile(join(root, 'shared/src/world.json'));
  const world: unknown = JSON.parse(bytes.toString()); validateWorld(world);
  return { world, revision: createHash('sha256').update(bytes).digest('hex') };
}
export function buildCamera(world: World, region: string) {
  const r = world.regions[region];
  return { region, origin: r.origin, headingDeg: r.headingDeg, pitchDeg: 45, mpp: 0.25, tile: 1024 };
}
export async function checkManifest(root: string, name: string, input: Pick<BuildInput, 'area' | 'camera'>, required = false) {
  const directory = join(root, 'data/derived', name);
  const manifest = await optionalJson<{ area: string; bbox: unknown; camera: unknown; tiles: { x: number; y: number }[]; attributions?: string[] }>(join(directory, 'manifest.json'));
  if (!manifest) {
    const files = await readdir(join(directory, 'render')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (required || files.length) throw new EditorError('Render manifest is missing; cached tiles cannot be safely reused.', 409);
    return null;
  }
  if (manifest.area !== name || !isDeepStrictEqual(manifest.bbox, input.area.bbox) || !isDeepStrictEqual(manifest.camera, input.camera)) {
    throw new EditorError('Existing render bounds or camera differ from this saved area. Use a new area identifier.', 409);
  }
  return manifest;
}
function alive(pid: number | undefined) {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export function buildGroupAlive(pid: number | undefined) {
  if (process.platform === 'win32' || !pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class BuildManager {
  readonly directory: string;
  readonly lockPath: string;
  constructor(readonly root = rootPath) {
    this.directory = join(root, 'data/editor'); this.lockPath = join(this.directory, 'build.lock', 'owner.json');
  }
  jobDirectory(id: string) {
    if (!BUILD_ID.test(id)) throw new EditorError('Invalid build identifier');
    return join(this.directory, 'jobs', id);
  }
  async readJob(id: string) { return readJson<BuildJob>(join(this.jobDirectory(id), 'job.json')); }
  async writeJob(job: BuildJob) { await atomicJson(join(this.jobDirectory(job.id), 'job.json'), job); }
  async release(token: string) {
    const lock = await optionalJson<Lock>(this.lockPath);
    if (lock?.token !== token) return;
    // Only the caller that removes this token may release the directory.
    try { await unlink(join(this.directory, 'build.lock', token)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await unlink(this.lockPath);
    await rmdir(join(this.directory, 'build.lock')).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
  private async active(): Promise<BuildJob | null> {
    const lock = await optionalJson<Lock>(this.lockPath);
    if (!lock) return null;
    if (!lock.id) {
      if (!alive(lock.pid)) await this.release(lock.token);
      return null;
    }
    const job = await optionalJson<BuildJob>(join(this.jobDirectory(lock.id), 'job.json'));
    if (alive(lock.pid)) return job;
    if (job?.status === 'running') {
      job.status = 'interrupted'; job.finishedAt = new Date().toISOString();
      job.message = 'Build worker stopped. Retry the build.';
      await this.writeJob(job);
    }
    // A stage can outlive its worker; retain ownership until that process exits.
    if (alive(lock.childPid) || buildGroupAlive(lock.childPid) || buildGroupAlive(lock.groupPid)) {
      if (job) job.message = 'Build worker stopped; its pipeline stage is still running. Retry after it exits.';
      return job;
    }
    await this.release(lock.token);
    return null;
  }
  private async acquire(id: string | null) {
    await mkdir(join(this.directory, 'jobs'), { recursive: true });
    await this.active();
    const lock: Lock = { id, token: randomUUID(), pid: process.pid };
    const temporary = join(this.directory, `.lock-${lock.token}`);
    await mkdir(temporary);
    try {
      await writeFile(join(temporary, 'owner.json'), JSON.stringify(lock));
      await writeFile(join(temporary, lock.token), '');
      await rename(temporary, join(this.directory, 'build.lock'));
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new EditorError('Another build or configuration save is active. Wait for it to finish.', 409);
      throw error;
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return lock;
  }
  async withSaveLock<T>(save: () => Promise<T>): Promise<T> {
    const lock = await this.acquire(null);
    try { return await save(); } finally { await this.release(lock.token); }
  }
  private async publicJob(job: BuildJob | null) {
    if (!job) return null;
    const path = join(this.jobDirectory(job.id), 'output.log');
    let log = '';
    try {
      const file = await open(path, 'r');
      try { const size = (await file.stat()).size; const buffer = Buffer.alloc(Math.min(size, 64 * 1024)); await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length)); log = buffer.toString(); }
      finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { ...job, log };
  }
  async snapshot(area?: string): Promise<BuildSnapshot> {
    if (area !== undefined && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(area) || area.length > 100)) throw new EditorError('Invalid area identifier');
    let active = await this.active();
    let job: BuildJob | null = null;
    if (area) {
      const ids = await readdir(join(this.directory, 'jobs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const id of ids.filter(id => BUILD_ID.test(id))) {
        let candidate = await this.readJob(id);
        if (candidate.status === 'running' && candidate.id !== active?.id) {
          // A build may have started after this polling request began.
          active = await this.active();
          candidate = await this.readJob(id);
          if (candidate.status === 'running' && candidate.id !== active?.id) {
            candidate = { ...candidate, status: 'interrupted', finishedAt: new Date().toISOString(), message: 'Build worker stopped. Retry the build.' };
            await this.writeJob(candidate);
          }
        }
        if (candidate.area === area && (!job || candidate.startedAt > job.startedAt)) job = candidate;
      }
    }
    return { active: await this.publicJob(active), job: await this.publicJob(job) };
  }
  private async checkRawCache(area: string, input: BuildInput, hasManifest: boolean) {
    if (hasManifest) return;
    const raw = await readdir(join(this.root, 'data/raw', area)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!raw.length) return;
    const ids = await readdir(join(this.directory, 'jobs'));
    let prior: BuildJob | undefined;
    for (const id of ids.filter(id => BUILD_ID.test(id))) {
      const job = await this.readJob(id);
      if (job.area === area && (!prior || job.startedAt > prior.startedAt)) prior = job;
    }
    const previous = prior ? await readJson<BuildInput>(join(this.jobDirectory(prior.id), 'input.json')) : null;
    if (!previous || !isDeepStrictEqual(previous.area.bbox, input.area.bbox) || !isDeepStrictEqual(previous.camera, input.camera)) {
      throw new EditorError('Cached raw data has different or unverified bounds/camera. Use a new area identifier.', 409);
    }
  }
  async start(area: unknown, revision: unknown): Promise<BuildJob> {
    if (typeof area !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(area) || area.length > 100) throw new EditorError('Invalid area identifier');
    if (typeof revision !== 'string') throw new EditorError('revision must be a string');
    const id = randomUUID(), lock = await this.acquire(id);
    let job: BuildJob | undefined;
    try {
      const saved = await readBuildWorld(this.root);
      if (saved.revision !== revision) throw new EditorError('Configuration changed on disk. Reload before building.', 409);
      if (!Object.hasOwn(saved.world.areas, area)) throw new EditorError('Unknown saved area');
      const config = saved.world.areas[area], region = saved.world.regions[config.region];
      if (config.bbox[2] - config.bbox[0] > 0.25 || config.bbox[3] - config.bbox[1] > 0.25) throw new EditorError('Build areas must be no wider or taller than 0.25 degrees.');
      let env: Record<string, string | undefined> = {};
      try { env = parseEnv(await readFile(join(this.root, '.env'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let chrome: string | undefined = process.env.CHROME_PATH ?? env.CHROME_PATH;
      const candidates = chrome ? [chrome] : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
      chrome = undefined;
      for (const candidate of candidates) { try { await access(candidate, constants.X_OK); chrome = candidate; break; } catch { /* Try the next installed browser. */ } }
      if (!chrome) throw new EditorError('Chrome/Chromium was not found. Set CHROME_PATH before building.');
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      await access(fileURLToPath(loader), constants.R_OK);
      for (const stage of ['fetch', 'ground', 'scene', 'render']) await access(join(this.root, 'pipeline/src', `${stage}.ts`), constants.R_OK);
      const input: BuildInput = { root: this.root, revision, area: config, camera: buildCamera(saved.world, config.region), chrome, loader };
      const manifest = await checkManifest(this.root, area, input);
      await this.checkRawCache(area, input, !!manifest);
      job = { id, area, region: config.region, title: config.title, status: 'running', stage: 'fetch', completedStages: [], startedAt: new Date().toISOString(), log: '', credits: [...new Set([...region.credits, COPERNICUS_CREDIT])] };
      const directory = this.jobDirectory(id);
      await mkdir(directory);
      await writeFile(join(directory, 'input.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
      await this.writeJob(job);
      const log = await open(join(directory, 'output.log'), 'a');
      let child;
      try {
        child = spawn(process.execPath, ['--import', loader, fileURLToPath(new URL('./build-worker.ts', import.meta.url)), this.root, id], { cwd: this.root, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, CHROME_PATH: chrome } });
        await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
      } finally { await log.close(); }
      child.unref();
      lock.pid = child.pid!;
      lock.groupPid = child.pid!;
      await atomicJson(this.lockPath, lock);
      await writeFile(join(directory, 'ready'), '');
      return job;
    } catch (error) {
      if (job) await this.writeJob({ ...job, status: 'failed', finishedAt: new Date().toISOString(), message: error instanceof Error ? error.message : 'Unable to start build' });
      await this.release(lock.token); throw error;
    }
  }
  async preview(id: string): Promise<Buffer> {
    if (!BUILD_ID.test(id)) throw new EditorError('Invalid build identifier');
    const job = await optionalJson<BuildJob>(join(this.jobDirectory(id), 'job.json'));
    if (job?.status !== 'succeeded') throw new EditorError('A completed preview was not found.', 404);
    return readFile(join(this.jobDirectory(id), 'preview.webp'));
  }
}
