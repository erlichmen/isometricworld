import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { World } from '../../shared/src/index.ts';
import { validateWorld } from '../../shared/src/validate.ts';

export class EditorError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface Snapshot { world: World; revision: string; locks: Record<string, string> }
export const rootPath = resolve(import.meta.dirname, '../..');

export class WorldStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: { root?: string; fetch?: typeof fetch; rename?: typeof rename; tilesOrigin?: string } = {}) {}
  private get root() { return this.options.root ?? rootPath; }
  private get file() { return join(this.root, 'shared/src/world.json'); }
  private async read() {
    const bytes = await readFile(this.file);
    const world: unknown = JSON.parse(bytes.toString());
    validateWorld(world);
    return { world, revision: createHash('sha256').update(bytes).digest('hex') };
  }
  async locks(world: World) {
    const locks: Record<string, string> = {};
    let origin = this.options.tilesOrigin ?? process.env.TILES_ORIGIN;
    if (origin === undefined) {
      try { origin = parseEnv(await readFile(join(this.root, '.env'), 'utf8')).TILES_ORIGIN; }
      catch { /* Missing configuration is handled conservatively below. */ }
    }
    await Promise.all(Object.keys(world.regions).map(async id => {
      if (id === 'israel-center') { locks[id] = 'Existing Israel Center camera is fixed.'; return; }
      const paths = [join(this.root, 'data/web/regions', id), join(this.root, 'data/web-state', `${id}.json`),
        ...Object.entries(world.areas).filter(([, area]) => area.region === id).map(([name]) => join(this.root, 'data/derived', name))];
      for (const path of paths) {
        try { await stat(path); locks[id] = 'Local generated or published artifacts exist.'; return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { locks[id] = 'Local artifact state could not be verified.'; return; } }
      }
      if (!origin) { locks[id] = 'Production artifact absence cannot be verified: TILES_ORIGIN is missing.'; return; }
      try {
        const base = new URL(origin);
        if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid origin');
        const url = new URL(`regions/${id}/data/world.json`, `${base.href.replace(/\/$/, '')}/`);
        const request = this.options.fetch ?? fetch;
        const response = await request(url, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (response.status === 404) return;
        if (response.ok) { locks[id] = 'Production map metadata exists.'; return; }
        await response.body?.cancel();
        const fallback = await request(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        await fallback.body?.cancel();
        if (fallback.status === 404) return;
        locks[id] = fallback.ok ? 'Production map metadata exists.' : 'Production artifact absence could not be verified.';
      } catch { locks[id] = 'Production artifact absence could not be verified.'; }
    }));
    return locks;
  }
  async snapshot(): Promise<Snapshot> {
    const current = await this.read();
    return { ...current, locks: await this.locks(current.world) };
  }
  save(world: unknown, revision: unknown): Promise<Snapshot> {
    const save = this.queue.then(async () => {
      validateWorld(world);
      if (typeof revision !== 'string') throw new EditorError('revision must be a string');
      const current = await this.read();
      if (revision !== current.revision) throw new EditorError('Configuration changed on disk. Reload before saving.', 409);
      for (const table of ['regions', 'areas', 'cities'] as const) {
        for (const id of Object.keys(current.world[table])) {
          if (!Object.hasOwn(world[table], id)) throw new EditorError(`Existing ${table} identifier ${id} cannot be removed or renamed.`);
          if (table !== 'regions' && world[table][id].region !== current.world[table][id].region) throw new EditorError(`Existing ${table} ${id} cannot change region.`);
        }
      }
      for (const [id, region] of Object.entries(current.world.regions)) {
        if (!region.credits.every(credit => world.regions[id].credits.some(line => line.includes(credit)))) {
          throw new EditorError(`${id}: preserve existing source credits verbatim; additional credit text is allowed.`);
        }
      }
      const locks = await this.locks(world);
      for (const [id, reason] of Object.entries(locks)) {
        const a = current.world.regions[id], b = world.regions[id];
        if (a && (a.headingDeg !== b.headingDeg || a.origin.lat !== b.origin.lat || a.origin.lon !== b.origin.lon || a.origin.h !== b.origin.h)) throw new EditorError(`${id}: camera is locked. ${reason}`);
      }
      const temporary = join(dirname(this.file), `.world-${randomUUID()}.tmp`);
      const bytes = JSON.stringify(world, null, 2) + '\n';
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        // Catch edits made outside this server while production locks were being checked.
        if ((await this.read()).revision !== revision) throw new EditorError('Configuration changed on disk. Reload before saving.', 409);
        await (this.options.rename ?? rename)(temporary, this.file);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { world, revision: createHash('sha256').update(bytes).digest('hex'), locks };
    });
    this.queue = save.catch(() => {});
    return save;
  }
}
