import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApi } from "../server/api.ts";
import type { BuildManager, BuildSnapshot } from "../server/builds.ts";

class StreamResponse extends EventEmitter {
  destroyed = false;
  frames: string[] = [];
  headers: Record<string, string> = {};
  status = 0;
  acceptWrites = true;
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  setTimeout() {}
  write(frame: string) { this.frames.push(frame); return this.acceptWrites; }
  end(frame?: string) { if (frame) this.frames.push(frame); this.destroyed = true; this.emit("close"); }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a build event");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "build-events-"));
  const file = join(directory, "state.json");
  let reads = 0;
  let fail = false;
  const response = new StreamResponse();
  const state: BuildSnapshot = { active: null, job: null };
  await writeFile(file, JSON.stringify(state));
  const builds = { directory, snapshot: async (area?: string) => {
    reads++;
    if (fail) throw new Error("Temporary read error");
    const state: BuildSnapshot = JSON.parse(await readFile(file, "utf8"));
    return { active: state.active, job: area === "sample" ? state.job : null };
  } } as unknown as BuildManager;
  const handler = createApi({ builds });
  const req = Object.assign(Readable.from([]), { method: "GET", url: "/api/editor/builds/events?area=sample", headers: { host: "127.0.0.1:4322" }, socket: { localPort: 4322, remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
  t.after(async () => { response.end(); await rm(directory, { recursive: true, force: true }); });
  await handler(req, response as unknown as ServerResponse, () => { throw new Error("Unexpected next"); });
  const save = async (state: BuildSnapshot) => { await writeFile(`${file}.tmp`, JSON.stringify(state)); await rename(`${file}.tmp`, file); };
  return { directory, response, state, save, reads: () => reads, fail: (value: boolean) => { fail = value; } };
}

test("SSE sends the initial snapshot and pushes changed worker state/logs across atomic file replacement", async t => {
  const f = await fixture(t);
  assert.equal(f.response.status, 200);
  assert.match(f.response.headers["Content-Type"], /text\/event-stream/);
  assert.equal(f.response.headers["X-Accel-Buffering"], "no");
  assert.equal(f.response.headers["Cache-Control"], "no-cache, no-transform");
  assert.match(f.response.frames.join(""), /retry: 1000/);
  assert.match(f.response.frames.join(""), /event: build-state\ndata: {"active":null,"job":null}/);
  const state = { active: null, job: { id: "job", area: "sample", stage: "preview", status: "succeeded", log: "line one\nevent: not-a-real-event", previewUrl: "/preview.webp" } } as unknown as BuildSnapshot;
  await f.save(state);
  await waitFor(() => f.response.frames.some(frame => frame.includes('"status":"succeeded"')));
  const last = f.response.frames.at(-1)!;
  assert.equal(last.split("\n").filter(line => line.startsWith("event:")).length, 1);
  assert.deepEqual(JSON.parse(last.split("\ndata: ")[1].trim()), state);
  const frameCount = f.response.frames.length;
  const reads = f.reads();
  await f.save(state);
  await waitFor(() => f.reads() > reads);
  assert.equal(f.response.frames.length, frameCount, "unchanged snapshots must not be retransmitted");
});

test("SSE coalesces slow-client updates until drain and cleans up on disconnect", async t => {
  const f = await fixture(t);
  f.response.acceptWrites = false;
  await f.save({ active: null, job: { stage: "fetch" } } as unknown as BuildSnapshot);
  await waitFor(() => f.response.listenerCount("drain") === 1);
  const frames = f.response.frames.length;
  await f.save({ active: null, job: { stage: "render" } } as unknown as BuildSnapshot);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.response.frames.length, frames);
  f.response.acceptWrites = true;
  f.response.emit("drain");
  await waitFor(() => f.response.frames.some(frame => frame.includes('"stage":"render"')));
  f.response.end();
  const closedFrames = f.response.frames.length;
  const closedReads = f.reads();
  await f.save({ active: null, job: null });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.response.frames.length, closedFrames);
  assert.equal(f.reads(), closedReads);
  assert.equal(f.response.listenerCount("drain"), 0);
});

test("SSE read errors recover even when the snapshot has not changed", async t => {
  const f = await fixture(t);
  f.fail(true);
  await writeFile(join(f.directory, "changed"), "1");
  await waitFor(() => f.response.frames.some(frame => frame.includes("event: build-error")));
  f.fail(false);
  const states = f.response.frames.filter(frame => frame.includes("event: build-state")).length;
  await f.save({ active: null, job: null });
  await waitFor(() => f.response.frames.filter(frame => frame.includes("event: build-state")).length > states);
  await f.save({ active: null, job: { status: "failed", message: "Fixture failure" } } as unknown as BuildSnapshot);
  await waitFor(() => f.response.frames.some(frame => frame.includes("Fixture failure")));
});
