import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import type { BuildManager, BuildSnapshot } from "./builds.ts";

/** Watch durable worker output, so events work even after the editor server reloads. */
export async function streamBuilds(res: ServerResponse, builds: BuildManager, area?: string) {
  await mkdir(builds.directory, { recursive: true });
  let closed = res.destroyed;
  let ready = false;
  let reading = false;
  let changed = false;
  let blocked = false;
  let last = "";
  let watchError: Error | undefined;
  let watcher: FSWatcher | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function cleanup() {
    closed = true;
    watcher?.close();
    clearTimeout(pending);
    clearInterval(heartbeat);
    res.off("drain", drained);
  }
  function write(frame: string) {
    if (closed || blocked) return;
    if (!res.write(frame)) { blocked = true; res.once("drain", drained); }
  }
  function drained() { blocked = false; void refresh(); }
  function publish(snapshot: BuildSnapshot) {
    const json = JSON.stringify(snapshot);
    if (json !== last && !closed && !blocked) {
      last = json;
      write(`event: build-state\ndata: ${json}\n\n`);
    }
  }
  function schedule() {
    changed = true;
    if (closed || !ready || pending) return;
    pending = setTimeout(() => { pending = undefined; void refresh(); }, 75);
    pending.unref();
  }
  async function refresh() {
    if (closed || blocked || !ready) return;
    if (reading) { changed = true; return; }
    reading = true;
    changed = false;
    try { publish(await builds.snapshot(area)); }
    catch { last = ""; write('event: build-error\ndata: {"error":"Could not read build updates. Retrying…"}\n\n'); }
    finally { reading = false; if (changed) schedule(); }
  }
  res.once("close", cleanup);
  res.once("error", cleanup);
  try {
    if (closed) return;
    watcher = watch(builds.directory, { recursive: true }, schedule);
    watcher.on("error", failure => {
      if (!closed) {
        if (!ready) { watchError = failure; cleanup(); return; }
        write('event: build-error\ndata: {"error":"Build update watcher disconnected. Reconnecting…"}\n\n');
        cleanup();
        res.end();
      }
    });
    const initial = await builds.snapshot(area);
    if (watchError) throw watchError;
    if (closed) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.setTimeout(0);
    res.flushHeaders();
    write("retry: 1000\n\n");
    publish(initial);
    ready = true;
    if (changed) schedule();
    heartbeat = setInterval(() => {
      write(": heartbeat\n\n");
      // Reconcile dead workers as well as missed filesystem notifications.
      void refresh();
    }, 15_000);
    heartbeat.unref();
  } catch (error) { cleanup(); throw error; }
}
