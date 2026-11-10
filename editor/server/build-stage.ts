import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildManager, readJson } from './builds.ts';

const [root, id, stage] = process.argv.slice(2);
if (!['fetch', 'ground', 'scene', 'render'].includes(stage)) throw new Error('Invalid build stage');
const manager = new BuildManager(root), directory = manager.jobDirectory(id);
// A stage cannot write pipeline data until its process-group ownership is durable.
for (let i = 0; ; i++) {
  try { await access(join(directory, `${stage}.ready`)); break; }
  catch { if (i >= 100) throw new Error('Stage startup was interrupted.'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
const lock = await readJson<{ id: string; childPid: number }>(manager.lockPath);
if (lock.id !== id || lock.childPid !== process.pid) throw new Error('Stage ownership was lost');
const job = await manager.readJob(id), script = join(root, 'pipeline/src', `${stage}.ts`);
process.argv = [process.execPath, script, job.area, ...(stage === 'render' ? ['-j', '2'] : [])];
await import(pathToFileURL(script).href);
